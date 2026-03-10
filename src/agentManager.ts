import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState, PersistedAgent } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import {
	startFileWatching,
	readNewLines,
	ensureProjectScan,
	normalizeJsonlFilePath,
	releaseAgentClaims,
	registerAgentClaims,
} from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, WORKSPACE_KEY_AGENTS, WORKSPACE_KEY_AGENT_SEATS } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { AGENT_PROVIDER_IDS, getAgentProvider, resolveSessionRootDirs } from './providers.js';
import type { AgentProviderId } from './providers.js';

export function getProjectDirPath(provider: AgentProviderId, cwd?: string): string | null {
	return getProjectDirPaths(provider, cwd)[0] ?? null;
}

export function getProjectDirPaths(provider: AgentProviderId, cwd?: string): string[] {
	const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (provider === AGENT_PROVIDER_IDS.CODEX) {
		const sessionDirs = resolveSessionRootDirs(provider).map(rootDir => path.join(rootDir, 'sessions'));
		const projectHash = workspacePath ? workspacePath.replace(/[^a-zA-Z0-9-]/g, '-') : null;
		const projectDirs = projectHash
			? resolveSessionRootDirs(provider).map(rootDir => path.join(rootDir, 'projects', projectHash))
			: [];
		const allDirsByNormalized = new Map<string, string>();
		for (const dir of [...sessionDirs, ...projectDirs]) {
			const normalized = normalizeJsonlFilePath(dir);
			if (!allDirsByNormalized.has(normalized)) {
				allDirsByNormalized.set(normalized, dir);
			}
		}
		const allDirs = [...allDirsByNormalized.values()];
		console.log(`[Pixel Agents] ${provider} session dirs: ${workspacePath ?? 'none'} -> ${JSON.stringify(allDirs)}`);
		return allDirs;
	}
	if (!workspacePath) {
		return [];
	}
	const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
	const projectDirs = resolveSessionRootDirs(provider).map(rootDir => path.join(rootDir, 'projects', dirName));
	console.log(`[Pixel Agents] ${provider} project dirs: ${workspacePath} -> ${JSON.stringify(projectDirs)}`);
	return projectDirs;
}

export async function launchNewTerminal(
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	knownJsonlFiles: Set<string>,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimers: Map<string, ReturnType<typeof setInterval>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	providerId: AgentProviderId,
	folderPath?: string,
): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	const cwd = folderPath || folders?.[0]?.uri.fsPath;
	const isMultiRoot = !!(folders && folders.length > 1);
	const idx = nextTerminalIndexRef.current++;
	const provider = getAgentProvider(providerId);
	const terminal = vscode.window.createTerminal({
		name: `${provider.terminalNamePrefix} #${idx}`,
		cwd,
	});
	// Keep focus in the current UI when spawning an agent terminal.
	// This avoids triggering unrelated active-terminal handlers from other extensions.
	terminal.show(true);

	const projectDirs = getProjectDirPaths(providerId, cwd);
	if (projectDirs.length === 0) {
		console.log('[Pixel Agents] No project dir, cannot track agent');
		return;
	}

	const sessionId = provider.supportsSessionId ? crypto.randomUUID() : null;
	const launchCommand = sessionId
		? `${provider.command} --session-id ${sessionId}`
		: provider.command;
	terminal.sendText(launchCommand);

	const expectedFiles = sessionId
		? projectDirs.map(projectDir => path.join(projectDir, `${sessionId}.jsonl`))
		: [];
	for (const expectedFile of expectedFiles) {
		knownJsonlFiles.add(normalizeJsonlFilePath(expectedFile));
	}

	const id = nextAgentIdRef.current++;
	const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
	const agent: AgentState = {
		id,
		provider: providerId,
		terminalRef: terminal,
		workspacePath: cwd,
		launchTimeMs: Date.now(),
		projectDir: projectDirs[0],
		jsonlFile: expectedFiles[0] ?? '',
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		codexHasMeaningfulActivity: false,
		folderName,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();
	console.log(`[Pixel Agents] Agent ${id}: created for terminal ${terminal.name}`);
	webview?.postMessage({ type: 'agentCreated', id, folderName });

	for (const projectDir of projectDirs) {
		ensureProjectScan(
			providerId,
			projectDir,
			knownJsonlFiles,
			claimedJsonlFiles,
			claimedCodexSessions,
			projectScanTimers,
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
	}

	if (expectedFiles.length === 0) {
		console.log(`[Pixel Agents] Agent ${id}: waiting for ${provider.label} transcript via project scan`);
		return;
	}

	const pollTimer = setInterval(() => {
		try {
			const matchIndex = expectedFiles.findIndex(filePath => fs.existsSync(filePath));
			if (matchIndex !== -1) {
				agent.projectDir = projectDirs[matchIndex];
				agent.jsonlFile = expectedFiles[matchIndex];
				agent.claimedJsonlFile = normalizeJsonlFilePath(agent.jsonlFile);
				claimedJsonlFiles.set(agent.claimedJsonlFile, id);
				console.log(`[Pixel Agents] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`);
				clearInterval(pollTimer);
				jsonlPollTimers.delete(id);
				persistAgents();
				startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
				readNewLines(id, agents, waitingTimers, permissionTimers, webview);
			}
		} catch {
			/* file may not exist yet */
		}
	}, JSONL_POLL_INTERVAL_MS);
	jsonlPollTimers.set(id, pollTimer);
}

export function removeAgent(
	agentId: number,
	agents: Map<number, AgentState>,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) {
		return;
	}

	const jpTimer = jsonlPollTimers.get(agentId);
	if (jpTimer) {
		clearInterval(jpTimer);
	}
	jsonlPollTimers.delete(agentId);

	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) {
		clearInterval(pt);
	}
	pollingTimers.delete(agentId);
	try {
		fs.unwatchFile(agent.jsonlFile);
	} catch {
		/* ignore */
	}

	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);
	releaseAgentClaims(agent, claimedJsonlFiles, claimedCodexSessions);

	agents.delete(agentId);
	persistAgents();
}

export function persistAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
): void {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			provider: agent.provider,
			terminalName: agent.terminalRef.name,
			workspacePath: agent.workspacePath,
			launchTimeMs: agent.launchTimeMs,
			codexSessionId: agent.codexSessionId,
			claimedJsonlFile: agent.claimedJsonlFile,
			jsonlFile: agent.jsonlFile,
			projectDir: agent.projectDir,
			folderName: agent.folderName,
		});
	}
	context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	context: vscode.ExtensionContext,
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	knownJsonlFiles: Set<string>,
	claimedJsonlFiles: Map<string, number>,
	claimedCodexSessions: Map<string, number>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimers: Map<string, ReturnType<typeof setInterval>>,
	activeAgentIdRef: { current: number | null },
	webview: vscode.Webview | undefined,
	doPersist: () => void,
): void {
	const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (persisted.length === 0) {
		return;
	}

	const liveTerminals = vscode.window.terminals;
	let maxId = 0;
	let maxIdx = 0;
	const restoredScans = new Map<string, { provider: AgentProviderId; projectDir: string }>();

	for (const p of persisted) {
		const terminal = liveTerminals.find(t => t.name === p.terminalName);
		if (!terminal) {
			continue;
		}

		const provider = p.provider ?? AGENT_PROVIDER_IDS.CLAUDE;
		const agent: AgentState = {
			id: p.id,
			provider,
			terminalRef: terminal,
			workspacePath: p.workspacePath,
			launchTimeMs: p.launchTimeMs,
			codexSessionId: p.codexSessionId,
			claimedJsonlFile: p.claimedJsonlFile,
			projectDir: p.projectDir,
			jsonlFile: p.jsonlFile,
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
			codexHasMeaningfulActivity: false,
			folderName: p.folderName,
		};

		agents.set(p.id, agent);
		const hasExistingTranscript = !!(p.jsonlFile && fs.existsSync(p.jsonlFile));
		if (p.jsonlFile) {
			knownJsonlFiles.add(normalizeJsonlFilePath(p.jsonlFile));
		}
		if (provider !== AGENT_PROVIDER_IDS.CODEX || hasExistingTranscript) {
			registerAgentClaims(agent, claimedJsonlFiles, claimedCodexSessions);
		}
		console.log(`[Pixel Agents] Restored agent ${p.id} -> terminal "${p.terminalName}"`);

		if (p.id > maxId) {
			maxId = p.id;
		}
		const match = p.terminalName.match(/#(\d+)$/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIdx) {
				maxIdx = idx;
			}
		}

		restoredScans.set(`${provider}:${p.projectDir}`, { provider, projectDir: p.projectDir });

		try {
			if (hasExistingTranscript) {
				const stat = fs.statSync(p.jsonlFile);
				agent.fileOffset = stat.size;
				startFileWatching(p.id, p.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
			} else if (agent.jsonlFile && provider !== AGENT_PROVIDER_IDS.CODEX) {
				const pollTimer = setInterval(() => {
					try {
						if (fs.existsSync(agent.jsonlFile)) {
							console.log(`[Pixel Agents] Restored agent ${p.id}: found JSONL file`);
							clearInterval(pollTimer);
							jsonlPollTimers.delete(p.id);
							const stat = fs.statSync(agent.jsonlFile);
							agent.fileOffset = stat.size;
							startFileWatching(p.id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
						}
					} catch {
						/* file may not exist yet */
					}
				}, JSONL_POLL_INTERVAL_MS);
				jsonlPollTimers.set(p.id, pollTimer);
			}
		} catch {
			/* ignore errors during restore */
		}
	}

	if (maxId >= nextAgentIdRef.current) {
		nextAgentIdRef.current = maxId + 1;
	}
	if (maxIdx >= nextTerminalIndexRef.current) {
		nextTerminalIndexRef.current = maxIdx + 1;
	}

	doPersist();

	for (const { provider, projectDir } of restoredScans.values()) {
		ensureProjectScan(
			provider,
			projectDir,
			knownJsonlFiles,
			claimedJsonlFiles,
			claimedCodexSessions,
			projectScanTimers,
			activeAgentIdRef,
			nextAgentIdRef,
			agents,
			fileWatchers,
			pollingTimers,
			waitingTimers,
			permissionTimers,
			webview,
			doPersist,
		);
	}
}

export function sendExistingAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) {
		return;
	}
	const agentIds: number[] = [];
	for (const id of agents.keys()) {
		agentIds.push(id);
	}
	agentIds.sort((a, b) => a - b);

	const agentMeta = context.workspaceState.get<Record<string, { palette?: number; hueShift?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});

	const folderNames: Record<number, string> = {};
	for (const [id, agent] of agents) {
		if (agent.folderName) {
			folderNames[id] = agent.folderName;
		}
	}
	console.log(`[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`);

	webview.postMessage({
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
		folderNames,
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) {
		return;
	}
	for (const [agentId, agent] of agents) {
		for (const [toolId, status] of agent.activeToolStatuses) {
			webview.postMessage({
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		if (agent.isWaiting) {
			webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	}
}

export function sendLayout(
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) {
		return;
	}
	const layout = migrateAndLoadLayout(context, defaultLayout);
	webview.postMessage({
		type: 'layoutLoaded',
		layout,
	});
}
