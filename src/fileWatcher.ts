import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS, CODEX_SESSION_META_READ_MAX_BYTES } from './constants.js';
import { AGENT_PROVIDER_IDS } from './providers.js';
import type { AgentProviderId } from './providers.js';
import { parseCodexSessionMetaLine, readFirstLineFromFile } from './codexSessionMeta.js';

const CODEX_SESSION_MATCH_WINDOW_MS = 120000;

export interface CodexSessionInfo {
	filePath: string;
	normalizedFilePath: string;
	sessionId: string;
	cwd: string;
	originator?: string;
	timestamp?: string;
	mtimeMs: number;
}

export interface CopilotSessionInfo {
	filePath: string;
	normalizedFilePath: string;
	sessionId: string;
	cwd: string;
	gitRoot?: string;
	mtimeMs: number;
}

type CodexSessionInfoResult =
	| { kind: 'ok'; info: CodexSessionInfo }
	| { kind: 'empty' }
	| { kind: 'incomplete' }
	| { kind: 'invalid_json' }
	| { kind: 'not_session_meta' }
	| { kind: 'missing_fields' }
	| { kind: 'read_error' };

type CopilotSessionInfoResult =
	| { kind: 'ok'; info: CopilotSessionInfo }
	| { kind: 'missing_workspace_yaml' }
	| { kind: 'missing_fields' }
	| { kind: 'invalid_events_path' }
	| { kind: 'read_error' };

interface TranscriptLineEffects {
	clearPermission: boolean;
}

interface CodexScanSummary {
	scanned: number;
	parsed: number;
	matched: number;
	claimed: number;
	attached: number;
	reassigned: number;
	adopted: number;
	skippedKnown: number;
	skippedNoMeta: number;
	skippedWorkspaceMismatch: number;
	skippedRecentWindow: number;
	skippedNotInWorkspaceFolders: number;
}

interface CodexScanLogState {
	lastFileCount: number;
}

const codexScanLogStateByProjectDir = new Map<string, CodexScanLogState>();
const codexNoMatchReasonByAgentId = new Map<number, string>();

export function normalizeJsonlFilePath(filePath: string): string {
	return path.normalize(filePath).replace(/[\\/]+$/g, '').toLowerCase();
}

export function registerAgentClaims(
	agent: AgentState,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
): void {
	if (agent.claimedJsonlFile) {
		claimedJsonlFiles.set(agent.claimedJsonlFile, agent.id);
	}
	if (agent.codexSessionId) {
		claimedCodexSessions.set(agent.codexSessionId, agent.id);
	}
}

export function releaseAgentClaims(
	agent: AgentState,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
): void {
	if (agent.claimedJsonlFile && claimedJsonlFiles.get(agent.claimedJsonlFile) === agent.id) {
		claimedJsonlFiles.delete(agent.claimedJsonlFile);
	}
	if (agent.codexSessionId && claimedCodexSessions.get(agent.codexSessionId) === agent.id) {
		claimedCodexSessions.delete(agent.codexSessionId);
	}
}

export function startFileWatching(
	agentId: number,
	filePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	try {
		const watcher = fs.watch(filePath, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
		fileWatchers.set(agentId, watcher);
	} catch (e) {
		console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
	}

	try {
		fs.watchFile(filePath, { interval: FILE_WATCHER_POLL_INTERVAL_MS }, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
	} catch (e) {
		console.log(`[Pixel Agents] fs.watchFile failed for agent ${agentId}: ${e}`);
	}

	const interval = setInterval(() => {
		if (!agents.has(agentId)) {
			clearInterval(interval);
			try { fs.unwatchFile(filePath); } catch { /* ignore */ }
			return;
		}
		readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
	}, FILE_WATCHER_POLL_INTERVAL_MS);
	pollingTimers.set(agentId, interval);
}

export function readNewLines(
	agentId: number,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent || !agent.jsonlFile) {return;}
	try {
		const stat = fs.statSync(agent.jsonlFile);
		if (stat.size <= agent.fileOffset) {return;}

		const buf = Buffer.alloc(stat.size - agent.fileOffset);
		const fd = fs.openSync(agent.jsonlFile, 'r');
		fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
		fs.closeSync(fd);
		const bytesRead = stat.size - agent.fileOffset;
		agent.fileOffset = stat.size;
		console.log(`[Pixel Agents] Agent ${agentId}: read ${bytesRead} bytes from ${path.basename(agent.jsonlFile)}`);

		const text = agent.lineBuffer + buf.toString('utf-8');
		const lines = text.split('\n');
		agent.lineBuffer = lines.pop() || '';

		// Cancel waiting timer on any new data (prevents premature idle on untracked record types)
		cancelWaitingTimer(agentId, waitingTimers);

		const effects: TranscriptLineEffects = {
			clearPermission: false,
		};

		for (const line of lines) {
			if (!line.trim()) {continue;}
			const lineEffects = processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
			effects.clearPermission = effects.clearPermission || lineEffects.clearPermission;
		}

		if (effects.clearPermission) {
			cancelPermissionTimer(agentId, permissionTimers);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
			}
		}
	} catch (e) {
		console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
	}
}

export function ensureProjectScan(
	providerId: AgentProviderId,
	projectDir: string,
	knownJsonlFiles: Set<string>,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	projectScanTimers: Map<string, ReturnType<typeof setInterval>>,
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const timerKey = `${providerId}:${projectDir}`;
	if (projectScanTimers.has(timerKey)) {return;}

	try {
		const initialFiles = listJsonlFiles(providerId, projectDir);
		for (const file of initialFiles) {
			knownJsonlFiles.add(normalizeJsonlFilePath(file));
		}
		if (providerId === AGENT_PROVIDER_IDS.CODEX) {
			attachCodexAgentsToSessions(
				projectDir,
				initialFiles,
				activeAgentIdRef,
				agents,
				claimedJsonlFiles,
				claimedCodexSessions,
				fileWatchers,
				pollingTimers,
				waitingTimers,
				permissionTimers,
				webview,
				persistAgents,
			);
		} else if (providerId === AGENT_PROVIDER_IDS.COPILOT) {
			attachCopilotAgentsToSessions(
				projectDir,
				initialFiles,
				activeAgentIdRef,
				agents,
				claimedJsonlFiles,
				claimedCodexSessions,
				fileWatchers,
				pollingTimers,
				waitingTimers,
				permissionTimers,
				webview,
				persistAgents,
			);
		} else {
			attachExistingSessionIfNeeded(
				providerId,
				projectDir,
				initialFiles,
				activeAgentIdRef,
				agents,
				claimedJsonlFiles,
				claimedCodexSessions,
				fileWatchers,
				pollingTimers,
				waitingTimers,
				permissionTimers,
				webview,
				persistAgents,
			);
		}
	} catch { /* dir may not exist yet */ }

	const timer = setInterval(() => {
		scanForNewJsonlFiles(
			providerId,
			projectDir,
			knownJsonlFiles,
			claimedJsonlFiles,
			claimedCodexSessions,
			activeAgentIdRef,
			nextAgentIdRef,
			agents,
			fileWatchers,
			pollingTimers,
			waitingTimers,
			permissionTimers,
			webview,
			persistAgents,
		);
	}, PROJECT_SCAN_INTERVAL_MS);
	projectScanTimers.set(timerKey, timer);
}

function attachCodexAgentsToSessions(
	projectDir: string,
	files: string[],
	activeAgentIdRef: { current: number | null },
	agents: Map<number, AgentState>,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): number {
	const sessionInfos = files
		.map(file => getCodexSessionInfo(file))
		.filter((result): result is { kind: 'ok'; info: CodexSessionInfo } => result.kind === 'ok')
		.map(result => result.info)
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	if (sessionInfos.length === 0) {
		return 0;
	}

	const candidateAgents = [...agents.values()]
		.filter(agent => needsProviderSessionAttachment(agent, AGENT_PROVIDER_IDS.CODEX))
		.sort((left, right) => {
			if (left.id === activeAgentIdRef.current) {
				return -1;
			}
			if (right.id === activeAgentIdRef.current) {
				return 1;
			}
			return right.id - left.id;
		});
	let attachedCount = 0;

	for (const agent of candidateAgents) {
		const workspaceMatches = sessionInfos
			.filter(info => matchesWorkspace(agent.workspacePath ?? '', info.cwd));
		const requireRecent = agent.launchTimeMs !== undefined && !agent.claimedJsonlFile;
		const candidate = findBestCodexCandidate(
			sessionInfos,
			agent,
			claimedJsonlFiles,
			claimedCodexSessions,
			requireRecent,
		);
		if (!candidate) {
			logCodexNoMatchReason(agent, workspaceMatches, requireRecent, projectDir);
			continue;
		}

		console.log(`[Pixel Agents] Attaching Codex agent ${agent.id} to ${path.basename(candidate.filePath)} (${candidate.sessionId})`);
		reassignAgentToFile(
			agent.id,
			candidate.filePath,
			agents,
			claimedJsonlFiles,
			claimedCodexSessions,
			fileWatchers,
			pollingTimers,
			waitingTimers,
			permissionTimers,
			webview,
			persistAgents,
			candidate,
		);
		const updatedAgent = agents.get(agent.id);
		if (updatedAgent) {
			updatedAgent.projectDir = projectDir;
		}
		codexNoMatchReasonByAgentId.delete(agent.id);
		attachedCount++;
	}
	return attachedCount;
}

function attachCopilotAgentsToSessions(
	projectDir: string,
	files: string[],
	activeAgentIdRef: { current: number | null },
	agents: Map<number, AgentState>,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): number {
	const sessionInfos = files
		.map(file => getCopilotSessionInfo(file))
		.filter((result): result is { kind: 'ok'; info: CopilotSessionInfo } => result.kind === 'ok')
		.map(result => result.info)
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	if (sessionInfos.length === 0) {
		return 0;
	}

	const candidateAgents = [...agents.values()]
		.filter(agent => needsProviderSessionAttachment(agent, AGENT_PROVIDER_IDS.COPILOT))
		.sort((left, right) => {
			if (left.id === activeAgentIdRef.current) {
				return -1;
			}
			if (right.id === activeAgentIdRef.current) {
				return 1;
			}
			return right.id - left.id;
		});
	let attachedCount = 0;

	for (const agent of candidateAgents) {
		const candidate = findBestCopilotCandidate(
			sessionInfos,
			agent,
			claimedJsonlFiles,
			agent.launchTimeMs !== undefined && !agent.claimedJsonlFile,
		);
		if (!candidate) {
			continue;
		}

		console.log(`[Pixel Agents] Attaching Copilot agent ${agent.id} to ${path.basename(candidate.filePath)} (${candidate.sessionId})`);
		reassignAgentToFile(
			agent.id,
			candidate.filePath,
			agents,
			claimedJsonlFiles,
			claimedCodexSessions,
			fileWatchers,
			pollingTimers,
			waitingTimers,
			permissionTimers,
			webview,
			persistAgents,
			candidate,
		);
		const updatedAgent = agents.get(agent.id);
		if (updatedAgent) {
			updatedAgent.projectDir = projectDir;
		}
		attachedCount++;
	}

	return attachedCount;
}

function attachExistingSessionIfNeeded(
	providerId: AgentProviderId,
	projectDir: string,
	files: string[],
	activeAgentIdRef: { current: number | null },
	agents: Map<number, AgentState>,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	if (activeAgentIdRef.current === null) {
		return;
	}
	const agent = agents.get(activeAgentIdRef.current);
	if (!agent || agent.provider !== providerId || !agent.workspacePath || agent.claimedJsonlFile) {
		return;
	}

	if (providerId === AGENT_PROVIDER_IDS.COPILOT) {
		const candidate = findBestCopilotCandidate(
			files
				.map(file => getCopilotSessionInfo(file))
				.filter((result): result is { kind: 'ok'; info: CopilotSessionInfo } => result.kind === 'ok')
				.map(result => result.info),
			agent,
			claimedJsonlFiles,
			true,
		);
		if (!candidate) {
			return;
		}

		console.log(`[Pixel Agents] Found existing Copilot session for agent ${agent.id}: ${path.basename(candidate.filePath)} (${candidate.sessionId})`);
		reassignAgentToFile(
			agent.id,
			candidate.filePath,
			agents,
			claimedJsonlFiles,
			claimedCodexSessions,
			fileWatchers,
			pollingTimers,
			waitingTimers,
			permissionTimers,
			webview,
			persistAgents,
			candidate,
		);
		agent.projectDir = projectDir;
		return;
	}

	if (providerId !== AGENT_PROVIDER_IDS.CODEX) {
		return;
	}

	const candidate = findBestCodexCandidate(
		files
			.map(file => getCodexSessionInfo(file))
			.filter((result): result is { kind: 'ok'; info: CodexSessionInfo } => result.kind === 'ok')
			.map(result => result.info),
		agent,
		claimedJsonlFiles,
		claimedCodexSessions,
		true,
	);
	if (!candidate) {
		return;
	}

	console.log(`[Pixel Agents] Found existing Codex session for agent ${agent.id}: ${path.basename(candidate.filePath)} (${candidate.sessionId})`);
	reassignAgentToFile(
		agent.id,
		candidate.filePath,
		agents,
		claimedJsonlFiles,
		claimedCodexSessions,
		fileWatchers,
		pollingTimers,
		waitingTimers,
		permissionTimers,
		webview,
		persistAgents,
		candidate,
	);
	agent.projectDir = projectDir;
}

function scanForNewJsonlFiles(
	providerId: AgentProviderId,
	projectDir: string,
	knownJsonlFiles: Set<string>,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	let files: string[];
	try {
		files = listJsonlFiles(providerId, projectDir);
	} catch {
		return;
	}
	const codexSummary: CodexScanSummary | null = providerId === AGENT_PROVIDER_IDS.CODEX
		? {
			scanned: 0,
			parsed: 0,
			matched: 0,
			claimed: 0,
			attached: 0,
			reassigned: 0,
			adopted: 0,
			skippedKnown: 0,
			skippedNoMeta: 0,
			skippedWorkspaceMismatch: 0,
			skippedRecentWindow: 0,
			skippedNotInWorkspaceFolders: 0,
		}
		: null;

	if (providerId === AGENT_PROVIDER_IDS.CODEX) {
		if (!codexSummary) {return;}
		const logState = codexScanLogStateByProjectDir.get(projectDir);
		if (!logState || logState.lastFileCount !== files.length) {
			console.log(`[Pixel Agents] Codex scan root ${projectDir}: ${files.length} jsonl file(s)`);
			codexScanLogStateByProjectDir.set(projectDir, { lastFileCount: files.length });
		}
		codexSummary.attached += attachCodexAgentsToSessions(
			projectDir,
			files,
			activeAgentIdRef,
			agents,
			claimedJsonlFiles,
			claimedCodexSessions,
			fileWatchers,
			pollingTimers,
			waitingTimers,
			permissionTimers,
			webview,
			persistAgents,
		);
	}

	const activeAgent = activeAgentIdRef.current !== null ? agents.get(activeAgentIdRef.current) ?? null : null;
	const workspacePaths = vscode.workspace.workspaceFolders?.map(folder => normalizeJsonlFilePath(folder.uri.fsPath)) ?? [];

	for (const file of files) {
		const normalizedFilePath = normalizeJsonlFilePath(file);
		if (knownJsonlFiles.has(normalizedFilePath)) {
			continue;
		}

		if (providerId === AGENT_PROVIDER_IDS.COPILOT) {
			const sessionInfoResult = getCopilotSessionInfo(file);
			if (sessionInfoResult.kind !== 'ok') {
				console.log(`[Pixel Agents] Skipping Copilot session (${describeCopilotSessionInfoFailure(sessionInfoResult.kind)}): ${path.basename(file)}`);
				continue;
			}
			const sessionInfo = sessionInfoResult.info;
			if (knownJsonlFiles.has(sessionInfo.normalizedFilePath)) {
				continue;
			}
			if (claimedJsonlFiles.has(sessionInfo.normalizedFilePath)) {
				console.log(`[Pixel Agents] Skipping Copilot session (already claimed): ${path.basename(sessionInfo.filePath)}`);
				knownJsonlFiles.add(sessionInfo.normalizedFilePath);
				continue;
			}
			if (activeAgent?.provider === providerId && activeAgent.workspacePath) {
				if (!matchesWorkspace(activeAgent.workspacePath, sessionInfo.cwd)) {
					console.log(`[Pixel Agents] Skipping Copilot session (workspace mismatch): ${path.basename(sessionInfo.filePath)}`);
					continue;
				}
				if (!activeAgent.claimedJsonlFile && activeAgent.launchTimeMs !== undefined && sessionInfo.mtimeMs < activeAgent.launchTimeMs - CODEX_SESSION_MATCH_WINDOW_MS) {
					console.log(`[Pixel Agents] Skipping Copilot session (outside recent window): ${path.basename(sessionInfo.filePath)}`);
					continue;
				}
			} else if (workspacePaths.length > 0 && !matchesAnyWorkspacePath(workspacePaths, sessionInfo.cwd)) {
				console.log(`[Pixel Agents] Skipping Copilot session (not in workspace folders): ${path.basename(sessionInfo.filePath)}`);
				continue;
			}

			knownJsonlFiles.add(sessionInfo.normalizedFilePath);
			if (
				activeAgentIdRef.current !== null
				&& activeAgent?.provider === providerId
				&& activeAgent.workspacePath
				&& matchesWorkspace(activeAgent.workspacePath, sessionInfo.cwd)
			) {
				console.log(`[Pixel Agents] New Copilot session detected: ${path.basename(sessionInfo.filePath)} -> agent ${activeAgentIdRef.current}`);
				reassignAgentToFile(
					activeAgentIdRef.current,
					sessionInfo.filePath,
					agents,
					claimedJsonlFiles,
					claimedCodexSessions,
					fileWatchers,
					pollingTimers,
					waitingTimers,
					permissionTimers,
					webview,
					persistAgents,
					sessionInfo,
				);
				continue;
			}

			const existingCopilotAgent = [...agents.values()].find(a =>
				a.provider === AGENT_PROVIDER_IDS.COPILOT
				&& a.workspacePath
				&& matchesWorkspace(a.workspacePath, sessionInfo.cwd)
				&& a.claimedJsonlFile !== sessionInfo.normalizedFilePath
			);
			if (existingCopilotAgent) {
				console.log(`[Pixel Agents] New Copilot session ${path.basename(sessionInfo.filePath)} -> reassigning agent ${existingCopilotAgent.id}`);
				reassignAgentToFile(
					existingCopilotAgent.id,
					sessionInfo.filePath,
					agents,
					claimedJsonlFiles,
					claimedCodexSessions,
					fileWatchers,
					pollingTimers,
					waitingTimers,
					permissionTimers,
					webview,
					persistAgents,
					sessionInfo,
				);
				continue;
			}

			const activeTerminal = vscode.window.activeTerminal;
			if (activeTerminal && !terminalIsOwned(activeTerminal, agents)) {
				adoptTerminalForFile(
					activeTerminal,
					providerId,
					sessionInfo.filePath,
					projectDir,
					nextAgentIdRef,
					agents,
					activeAgentIdRef,
					claimedJsonlFiles,
					claimedCodexSessions,
					fileWatchers,
					pollingTimers,
					waitingTimers,
					permissionTimers,
					webview,
					persistAgents,
					sessionInfo,
				);
			}
			continue;
		}

		if (providerId === AGENT_PROVIDER_IDS.CODEX) {
			if (!codexSummary) {continue;}
			codexSummary.scanned++;
			const sessionInfoResult = getCodexSessionInfo(file);
			if (sessionInfoResult.kind !== 'ok') {
				codexSummary.skippedNoMeta++;
				console.log(`[Pixel Agents] Skipping Codex JSONL (${describeCodexSessionInfoFailure(sessionInfoResult.kind)}): ${path.basename(file)}`);
				continue;
			}
			const sessionInfo = sessionInfoResult.info;
			codexSummary.parsed++;
			console.log(`[Pixel Agents] Found Codex JSONL: ${path.basename(sessionInfo.filePath)} (cwd=${sessionInfo.cwd})`);
			if (knownJsonlFiles.has(sessionInfo.normalizedFilePath)) {
				codexSummary.skippedKnown++;
				continue;
			}
			if (claimedJsonlFiles.has(sessionInfo.normalizedFilePath) || claimedCodexSessions.has(sessionInfo.sessionId)) {
				codexSummary.claimed++;
				console.log(`[Pixel Agents] Skipping Codex JSONL (already claimed): ${path.basename(sessionInfo.filePath)}`);
				knownJsonlFiles.add(sessionInfo.normalizedFilePath);
				continue;
			}
			if (activeAgent?.provider === providerId && activeAgent.workspacePath) {
				if (!matchesWorkspace(activeAgent.workspacePath, sessionInfo.cwd)) {
					codexSummary.skippedWorkspaceMismatch++;
					console.log(`[Pixel Agents] Skipping Codex JSONL (workspace mismatch): ${path.basename(sessionInfo.filePath)}`);
					continue;
				}
				if (!activeAgent.claimedJsonlFile && activeAgent.launchTimeMs !== undefined && sessionInfo.mtimeMs < activeAgent.launchTimeMs - CODEX_SESSION_MATCH_WINDOW_MS) {
					codexSummary.skippedRecentWindow++;
					console.log(`[Pixel Agents] Skipping Codex JSONL (outside recent window): ${path.basename(sessionInfo.filePath)}`);
					continue;
				}
			} else if (workspacePaths.length > 0 && !matchesAnyWorkspacePath(workspacePaths, sessionInfo.cwd)) {
				codexSummary.skippedNotInWorkspaceFolders++;
				console.log(`[Pixel Agents] Skipping Codex JSONL (not in workspace folders): ${path.basename(sessionInfo.filePath)}`);
				continue;
			}

			codexSummary.matched++;
			knownJsonlFiles.add(sessionInfo.normalizedFilePath);
			if (
				activeAgentIdRef.current !== null
				&& activeAgent?.provider === providerId
				&& activeAgent.workspacePath
				&& matchesWorkspace(activeAgent.workspacePath, sessionInfo.cwd)
			) {
				console.log(`[Pixel Agents] New Codex session detected: ${path.basename(sessionInfo.filePath)} -> agent ${activeAgentIdRef.current}`);
				reassignAgentToFile(
					activeAgentIdRef.current,
					sessionInfo.filePath,
					agents,
					claimedJsonlFiles,
					claimedCodexSessions,
					fileWatchers,
					pollingTimers,
					waitingTimers,
					permissionTimers,
					webview,
					persistAgents,
					sessionInfo,
				);
				codexSummary.reassigned++;
				continue;
			}

			// Find any Codex agent watching this workspace (even if watching an older session)
			// so new sessions are always followed even when a different agent is active.
			const existingCodexAgent = [...agents.values()].find(a =>
				a.provider === AGENT_PROVIDER_IDS.CODEX
				&& a.workspacePath
				&& matchesWorkspace(a.workspacePath, sessionInfo.cwd)
				&& a.codexSessionId !== sessionInfo.sessionId
			);
			if (existingCodexAgent) {
				console.log(`[Pixel Agents] New Codex session ${path.basename(sessionInfo.filePath)} -> reassigning agent ${existingCodexAgent.id}`);
				reassignAgentToFile(
					existingCodexAgent.id,
					sessionInfo.filePath,
					agents,
					claimedJsonlFiles,
					claimedCodexSessions,
					fileWatchers,
					pollingTimers,
					waitingTimers,
					permissionTimers,
					webview,
					persistAgents,
					sessionInfo,
				);
				codexSummary.reassigned++;
				continue;
			}

			const activeTerminal = vscode.window.activeTerminal;
			if (activeTerminal && !terminalIsOwned(activeTerminal, agents)) {
				adoptTerminalForFile(
					activeTerminal,
					providerId,
					sessionInfo.filePath,
					projectDir,
					nextAgentIdRef,
					agents,
					activeAgentIdRef,
					claimedJsonlFiles,
					claimedCodexSessions,
					fileWatchers,
					pollingTimers,
					waitingTimers,
					permissionTimers,
					webview,
					persistAgents,
					sessionInfo,
				);
				codexSummary.adopted++;
			}
			continue;
		}

		knownJsonlFiles.add(normalizedFilePath);
		if (activeAgentIdRef.current !== null) {
			console.log(`[Pixel Agents] New JSONL detected: ${path.basename(file)}, reassigning to agent ${activeAgentIdRef.current}`);
			reassignAgentToFile(
				activeAgentIdRef.current,
				file,
				agents,
				claimedJsonlFiles,
				claimedCodexSessions,
				fileWatchers,
				pollingTimers,
				waitingTimers,
				permissionTimers,
				webview,
				persistAgents,
			);
		} else {
			const activeTerminal = vscode.window.activeTerminal;
			if (activeTerminal && !terminalIsOwned(activeTerminal, agents)) {
				adoptTerminalForFile(
					activeTerminal,
					providerId,
					file,
					projectDir,
					nextAgentIdRef,
					agents,
					activeAgentIdRef,
					claimedJsonlFiles,
					claimedCodexSessions,
					fileWatchers,
					pollingTimers,
					waitingTimers,
					permissionTimers,
					webview,
					persistAgents,
				);
			}
		}
	}
	if (codexSummary && (
		codexSummary.scanned > 0
		|| codexSummary.attached > 0
		|| codexSummary.reassigned > 0
		|| codexSummary.adopted > 0
	)) {
		console.log(`[Pixel Agents] Codex scan summary ${projectDir}: scanned=${codexSummary.scanned}, parsed=${codexSummary.parsed}, matched=${codexSummary.matched}, claimed=${codexSummary.claimed}, attached=${codexSummary.attached}, reassigned=${codexSummary.reassigned}, adopted=${codexSummary.adopted}, skipped_known=${codexSummary.skippedKnown}, skipped_no_meta=${codexSummary.skippedNoMeta}, skipped_workspace_mismatch=${codexSummary.skippedWorkspaceMismatch}, skipped_recent_window=${codexSummary.skippedRecentWindow}, skipped_not_in_workspace_folders=${codexSummary.skippedNotInWorkspaceFolders}`);
	}
}

function needsProviderSessionAttachment(agent: AgentState, providerId: AgentProviderId): boolean {
	if (agent.provider !== providerId || !agent.workspacePath) {
		return false;
	}
	if (!agent.jsonlFile || !agent.claimedJsonlFile) {
		return true;
	}
	return !safePathExists(agent.jsonlFile);
}

function listJsonlFiles(providerId: AgentProviderId, projectDir: string): string[] {
	if (providerId === AGENT_PROVIDER_IDS.CODEX || providerId === AGENT_PROVIDER_IDS.COPILOT) {
		const deduped = new Map<string, string>();
		for (const file of listJsonlFilesRecursive(projectDir)) {
			const normalized = normalizeJsonlFilePath(file);
			if (!deduped.has(normalized)) {
				deduped.set(normalized, file);
			}
		}
		return [...deduped.values()];
	}
	return fs.readdirSync(projectDir)
		.filter(f => f.endsWith('.jsonl'))
		.map(f => path.join(projectDir, f));
}

function listJsonlFilesRecursive(rootDir: string): string[] {
	const results: string[] = [];
	const stack = [rootDir];
	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) {continue;}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
				results.push(fullPath);
			}
		}
	}
	return results;
}

function getCodexSessionInfo(filePath: string): CodexSessionInfoResult {
	try {
		const firstLine = readFirstLineFromFile(filePath, CODEX_SESSION_META_READ_MAX_BYTES);
		const parsed = parseCodexSessionMetaLine(firstLine.line, firstLine.isComplete);
		if (parsed.kind !== 'ok') {
			return parsed;
		}
		return {
			kind: 'ok',
			info: {
				filePath,
				normalizedFilePath: normalizeJsonlFilePath(filePath),
				sessionId: parsed.meta.sessionId,
				cwd: parsed.meta.cwd,
				originator: parsed.meta.originator,
				timestamp: parsed.meta.timestamp,
				mtimeMs: safeStatMtimeMs(filePath),
			},
		};
	} catch {
		return { kind: 'read_error' };
	}
}

function getCopilotSessionInfo(filePath: string): CopilotSessionInfoResult {
	if (path.basename(filePath).toLowerCase() !== 'events.jsonl') {
		return { kind: 'invalid_events_path' };
	}
	const sessionDir = path.dirname(filePath);
	const workspacePath = path.join(sessionDir, 'workspace.yaml');
	if (!safePathExists(workspacePath)) {
		return { kind: 'missing_workspace_yaml' };
	}
	try {
		const workspaceYaml = fs.readFileSync(workspacePath, 'utf-8');
		const parsed = parseCopilotWorkspaceYaml(workspaceYaml);
		if (!parsed.cwd || !parsed.id) {
			return { kind: 'missing_fields' };
		}
		return {
			kind: 'ok',
			info: {
				filePath,
				normalizedFilePath: normalizeJsonlFilePath(filePath),
				sessionId: parsed.id,
				cwd: parsed.cwd,
				gitRoot: parsed.gitRoot,
				mtimeMs: safeStatMtimeMs(filePath),
			},
		};
	} catch {
		return { kind: 'read_error' };
	}
}

function describeCodexSessionInfoFailure(kind: CodexSessionInfoResult['kind']): string {
	switch (kind) {
		case 'incomplete':
			return 'incomplete first line';
		case 'invalid_json':
			return 'invalid first-line json';
		case 'not_session_meta':
			return 'first line is not session_meta';
		case 'missing_fields':
			return 'session_meta missing required fields';
		case 'empty':
			return 'empty first line';
		case 'read_error':
			return 'read error';
		case 'ok':
			return 'ok';
	}
}

function describeCopilotSessionInfoFailure(kind: CopilotSessionInfoResult['kind']): string {
	switch (kind) {
		case 'missing_workspace_yaml':
			return 'missing workspace.yaml';
		case 'missing_fields':
			return 'workspace.yaml missing required fields';
		case 'invalid_events_path':
			return 'not an events.jsonl file';
		case 'read_error':
			return 'read error';
		case 'ok':
			return 'ok';
	}
}

function findBestCodexCandidate(
	sessionInfos: CodexSessionInfo[],
	agent: AgentState,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	requireRecent: boolean,
): CodexSessionInfo | null {
	if (!agent.workspacePath) {
		return null;
	}

	const candidates = sessionInfos
		.filter(info => matchesWorkspace(agent.workspacePath ?? '', info.cwd))
		.filter(info => !claimedJsonlFiles.has(info.normalizedFilePath))
		.filter(info => !claimedCodexSessions.has(info.sessionId))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	if (!requireRecent || agent.launchTimeMs === undefined) {
		return candidates[0] ?? null;
	}

	const launchTimeMs = agent.launchTimeMs;
	const recentCandidates = candidates.filter(
		info => info.mtimeMs >= launchTimeMs - CODEX_SESSION_MATCH_WINDOW_MS,
	);
	if (recentCandidates.length > 0) {
		return recentCandidates[0];
	}

	// For fresh agents (requireRecent=true), don't fall back to old completed sessions.
	// The scan timer will pick up the new session once Codex creates it.
	return null;
}

function findBestCopilotCandidate(
	sessionInfos: CopilotSessionInfo[],
	agent: AgentState,
	claimedJsonlFiles: Map<string, number>,
	requireRecent: boolean,
): CopilotSessionInfo | null {
	if (!agent.workspacePath) {
		return null;
	}

	const candidates = sessionInfos
		.filter(info => matchesWorkspace(agent.workspacePath ?? '', info.cwd))
		.filter(info => !claimedJsonlFiles.has(info.normalizedFilePath))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	if (!requireRecent || agent.launchTimeMs === undefined) {
		return candidates[0] ?? null;
	}

	const recentCandidates = candidates.filter(
		info => info.mtimeMs >= agent.launchTimeMs! - CODEX_SESSION_MATCH_WINDOW_MS,
	);
	return recentCandidates[0] ?? null;
}

function matchesWorkspace(left: string, right: string): boolean {
	const normalizedLeft = normalizeJsonlFilePath(left);
	const normalizedRight = normalizeJsonlFilePath(right);
	if (!normalizedLeft || !normalizedRight) {
		return false;
	}
	if (normalizedLeft === normalizedRight) {
		return true;
	}
	// Allow parent/child workspace relationships so sessions started from a subfolder still match.
	return normalizedLeft.startsWith(`${normalizedRight}${path.sep}`)
		|| normalizedRight.startsWith(`${normalizedLeft}${path.sep}`);
}

function matchesAnyWorkspacePath(workspacePaths: string[], sessionCwd: string): boolean {
	return workspacePaths.some(workspacePath => matchesWorkspace(workspacePath, sessionCwd));
}

function parseCopilotWorkspaceYaml(rawYaml: string): { id?: string; cwd?: string; gitRoot?: string } {
	const parsed: { id?: string; cwd?: string; gitRoot?: string } = {};
	for (const line of rawYaml.split(/\r?\n/)) {
		const match = line.match(/^([a-z_]+):\s*(.+?)\s*$/i);
		if (!match) {
			continue;
		}
		const key = match[1].toLowerCase();
		const value = match[2];
		if (key === 'id') {
			parsed.id = value;
		} else if (key === 'cwd') {
			parsed.cwd = value;
		} else if (key === 'git_root') {
			parsed.gitRoot = value;
		}
	}
	return parsed;
}

function logCodexNoMatchReason(
	agent: AgentState,
	workspaceMatches: CodexSessionInfo[],
	requireRecent: boolean,
	projectDir: string,
): void {
	let reason: string;
	if (workspaceMatches.length === 0) {
		reason = `no workspace match in ${projectDir}`;
	} else if (requireRecent && agent.launchTimeMs !== undefined) {
		const newest = workspaceMatches.reduce((best, current) => current.mtimeMs > best.mtimeMs ? current : best);
		reason = `workspace matches found but none recent; newest=${path.basename(newest.filePath)} mtime=${new Date(newest.mtimeMs).toISOString()}`;
	} else {
		reason = `workspace matches found but all are already claimed`;
	}
	if (codexNoMatchReasonByAgentId.get(agent.id) === reason) {
		return;
	}
	codexNoMatchReasonByAgentId.set(agent.id, reason);
	console.log(`[Pixel Agents] Agent ${agent.id}: waiting for Codex transcript (${reason})`);
}

function terminalIsOwned(terminal: vscode.Terminal, agents: Map<number, AgentState>): boolean {
	for (const agent of agents.values()) {
		if (agent.terminalRef === terminal) {
			return true;
		}
	}
	return false;
}

function safeStatMtimeMs(filePath: string): number {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}

function safePathExists(filePath: string): boolean {
	try {
		return fs.existsSync(filePath);
	} catch {
		return false;
	}
}

function applySessionClaim(
	agent: AgentState,
	sessionInfo: CodexSessionInfo | CopilotSessionInfo | undefined,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
): void {
	releaseAgentClaims(agent, claimedJsonlFiles, claimedCodexSessions);
	if (!sessionInfo) {
		agent.codexSessionId = undefined;
		agent.claimedJsonlFile = agent.jsonlFile ? normalizeJsonlFilePath(agent.jsonlFile) : undefined;
		if (agent.claimedJsonlFile) {
			claimedJsonlFiles.set(agent.claimedJsonlFile, agent.id);
		}
		return;
	}
	agent.workspacePath = sessionInfo.cwd;
	agent.codexSessionId = 'sessionId' in sessionInfo && agent.provider === AGENT_PROVIDER_IDS.CODEX
		? sessionInfo.sessionId
		: undefined;
	agent.claimedJsonlFile = sessionInfo.normalizedFilePath;
	claimedJsonlFiles.set(sessionInfo.normalizedFilePath, agent.id);
	if (agent.codexSessionId) {
		claimedCodexSessions.set(agent.codexSessionId, agent.id);
	}
}

function adoptTerminalForFile(
	terminal: vscode.Terminal,
	provider: AgentProviderId,
	jsonlFile: string,
	projectDir: string,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	sessionInfo?: CodexSessionInfo | CopilotSessionInfo,
): void {
	const id = nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		provider,
		terminalRef: terminal,
		workspacePath: sessionInfo?.cwd,
		codexSessionId: provider === AGENT_PROVIDER_IDS.CODEX ? sessionInfo?.sessionId : undefined,
		claimedJsonlFile: sessionInfo?.normalizedFilePath,
		projectDir,
		jsonlFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		currentStatus: 'none',
		permissionSent: false,
		hadToolsInTurn: false,
		codexHasMeaningfulActivity: false,
		copilotActiveParentToolIds: new Set(),
		copilotActiveChildToolIdsByParent: new Map(),
		copilotSubagents: new Map(),
		copilotLastAssistantActivityAt: 0,
	};

	applySessionClaim(agent, sessionInfo, claimedJsonlFiles, claimedCodexSessions);
	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	console.log(`[Pixel Agents] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`);
	webview?.postMessage({ type: 'agentCreated', id });

	startFileWatching(id, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

export function reassignAgentToFile(
	agentId: number,
	newFilePath: string,
	agents: Map<number, AgentState>,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	sessionInfo?: CodexSessionInfo | CopilotSessionInfo,
): void {
	const agent = agents.get(agentId);
	if (!agent) {return;}

	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);
	clearAgentActivity(
		agent,
		agentId,
		permissionTimers,
		webview,
		(agent.provider === AGENT_PROVIDER_IDS.CODEX || agent.provider === AGENT_PROVIDER_IDS.COPILOT)
			? { status: 'none' }
			: undefined,
	);

	agent.jsonlFile = newFilePath;
	agent.fileOffset = 0;
	agent.lineBuffer = '';
	applySessionClaim(agent, sessionInfo, claimedJsonlFiles, claimedCodexSessions);
	persistAgents();

	startFileWatching(agentId, newFilePath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
}
