import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS } from './constants.js';
import { AGENT_PROVIDER_IDS } from './providers.js';
import { cancelPermissionTimer, cancelWaitingTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentProviderId } from './providers.js';
import type { AgentState } from './types.js';

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
      try {
        fs.unwatchFile(filePath);
      } catch {
        /* ignore */
      }
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
  if (!agent || !agent.jsonlFile) {
    return;
  }
  try {
    const stat = fs.statSync(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) {
      return;
    }

    const buf = Buffer.alloc(stat.size - agent.fileOffset);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset = stat.size;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    cancelWaitingTimer(agentId, waitingTimers);

    let clearPermission = false;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const effects = processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
      clearPermission = clearPermission || effects.clearPermission;
    }

    if (clearPermission) {
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
  if (projectScanTimers.has(timerKey)) {
    return;
  }

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
  } catch {
    /* ignore */
  }

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
    .map((file) => getCodexSessionInfo(file))
    .filter((info): info is CodexSessionInfo => info !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (sessionInfos.length === 0) {
    return 0;
  }

  const candidateAgents = [...agents.values()]
    .filter((agent) => needsCodexSessionAttachment(agent))
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
    const workspaceMatches = sessionInfos.filter((info) => matchesWorkspace(agent.workspacePath ?? '', info.cwd));
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
  if (providerId !== AGENT_PROVIDER_IDS.CODEX || activeAgentIdRef.current === null) {
    return;
  }
  const agent = agents.get(activeAgentIdRef.current);
  if (!agent || agent.provider !== providerId || !agent.workspacePath || agent.claimedJsonlFile) {
    return;
  }

  const candidate = findBestCodexCandidate(
    files.map((file) => getCodexSessionInfo(file)).filter((info): info is CodexSessionInfo => info !== null),
    agent,
    claimedJsonlFiles,
    claimedCodexSessions,
    true,
  );
  if (!candidate) {
    return;
  }

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

  const codexSummary: CodexScanSummary | null =
    providerId === AGENT_PROVIDER_IDS.CODEX
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
    const logState = codexScanLogStateByProjectDir.get(projectDir);
    if (!logState || logState.lastFileCount !== files.length) {
      codexScanLogStateByProjectDir.set(projectDir, { lastFileCount: files.length });
    }
    if (codexSummary) {
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
  }

  const activeAgent = activeAgentIdRef.current !== null ? agents.get(activeAgentIdRef.current) ?? null : null;
  const workspacePaths = vscode.workspace.workspaceFolders?.map((folder) => normalizeJsonlFilePath(folder.uri.fsPath)) ?? [];

  for (const file of files) {
    const normalizedFilePath = normalizeJsonlFilePath(file);
    if (knownJsonlFiles.has(normalizedFilePath)) {
      continue;
    }

    if (providerId === AGENT_PROVIDER_IDS.CODEX) {
      if (!codexSummary) {
        continue;
      }
      codexSummary.scanned++;
      const sessionInfo = getCodexSessionInfo(file);
      if (!sessionInfo) {
        codexSummary.skippedNoMeta++;
        continue;
      }
      codexSummary.parsed++;
      if (knownJsonlFiles.has(sessionInfo.normalizedFilePath)) {
        codexSummary.skippedKnown++;
        continue;
      }
      if (claimedJsonlFiles.has(sessionInfo.normalizedFilePath) || claimedCodexSessions.has(sessionInfo.sessionId)) {
        codexSummary.claimed++;
        knownJsonlFiles.add(sessionInfo.normalizedFilePath);
        continue;
      }
      if (activeAgent?.provider === providerId && activeAgent.workspacePath) {
        if (!matchesWorkspace(activeAgent.workspacePath, sessionInfo.cwd)) {
          codexSummary.skippedWorkspaceMismatch++;
          continue;
        }
        if (
          !activeAgent.claimedJsonlFile &&
          activeAgent.launchTimeMs !== undefined &&
          sessionInfo.mtimeMs < activeAgent.launchTimeMs - CODEX_SESSION_MATCH_WINDOW_MS
        ) {
          codexSummary.skippedRecentWindow++;
          continue;
        }
      } else if (workspacePaths.length > 0 && !matchesAnyWorkspacePath(workspacePaths, sessionInfo.cwd)) {
        codexSummary.skippedNotInWorkspaceFolders++;
        continue;
      }

      codexSummary.matched++;
      knownJsonlFiles.add(sessionInfo.normalizedFilePath);
      if (
        activeAgentIdRef.current !== null &&
        activeAgent?.provider === providerId &&
        activeAgent.workspacePath &&
        matchesWorkspace(activeAgent.workspacePath, sessionInfo.cwd)
      ) {
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

      const existingCodexAgent = [...agents.values()].find(
        (agent) =>
          agent.provider === AGENT_PROVIDER_IDS.CODEX &&
          agent.workspacePath &&
          matchesWorkspace(agent.workspacePath, sessionInfo.cwd) &&
          agent.codexSessionId !== sessionInfo.sessionId,
      );
      if (existingCodexAgent) {
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
}

function needsCodexSessionAttachment(agent: AgentState): boolean {
  if (agent.provider !== AGENT_PROVIDER_IDS.CODEX || !agent.workspacePath) {
    return false;
  }
  if (!agent.jsonlFile || !agent.claimedJsonlFile) {
    return true;
  }
  return !safePathExists(agent.jsonlFile);
}

function listJsonlFiles(providerId: AgentProviderId, projectDir: string): string[] {
  if (providerId === AGENT_PROVIDER_IDS.CODEX) {
    const deduped = new Map<string, string>();
    for (const file of listJsonlFilesRecursive(projectDir)) {
      const normalized = normalizeJsonlFilePath(file);
      if (!deduped.has(normalized)) {
        deduped.set(normalized, file);
      }
    }
    return [...deduped.values()];
  }
  return fs
    .readdirSync(projectDir)
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .map((fileName) => path.join(projectDir, fileName));
}

function listJsonlFilesRecursive(rootDir: string): string[] {
  const results: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
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

function getCodexSessionInfo(filePath: string): CodexSessionInfo | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const firstLine = buffer.toString('utf-8', 0, bytesRead).split('\n')[0]?.trim();
    if (!firstLine) {
      return null;
    }
    const record = JSON.parse(firstLine) as { type?: string; payload?: Record<string, unknown> };
    if (record.type !== 'session_meta') {
      return null;
    }
    const sessionId = typeof record.payload?.id === 'string' ? record.payload.id : null;
    const cwd = typeof record.payload?.cwd === 'string' ? record.payload.cwd : null;
    if (!sessionId || !cwd) {
      return null;
    }
    return {
      filePath,
      normalizedFilePath: normalizeJsonlFilePath(filePath),
      sessionId,
      cwd,
      originator: typeof record.payload?.originator === 'string' ? record.payload.originator : undefined,
      timestamp: typeof record.payload?.timestamp === 'string' ? record.payload.timestamp : undefined,
      mtimeMs: safeStatMtimeMs(filePath),
    };
  } catch {
    return null;
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
    .filter((info) => matchesWorkspace(agent.workspacePath ?? '', info.cwd))
    .filter((info) => !claimedJsonlFiles.has(info.normalizedFilePath))
    .filter((info) => !claimedCodexSessions.has(info.sessionId))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!requireRecent || agent.launchTimeMs === undefined) {
    return candidates[0] ?? null;
  }

  const recentCandidates = candidates.filter(
    (info) => info.mtimeMs >= agent.launchTimeMs! - CODEX_SESSION_MATCH_WINDOW_MS,
  );
  if (recentCandidates.length > 0) {
    return recentCandidates[0];
  }
  return null;
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
  return (
    normalizedLeft.startsWith(`${normalizedRight}${path.sep}`) ||
    normalizedRight.startsWith(`${normalizedLeft}${path.sep}`)
  );
}

function matchesAnyWorkspacePath(workspacePaths: string[], sessionCwd: string): boolean {
  return workspacePaths.some((workspacePath) => matchesWorkspace(workspacePath, sessionCwd));
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
    const newest = workspaceMatches.reduce((best, current) => (current.mtimeMs > best.mtimeMs ? current : best));
    reason = `workspace matches found but none recent; newest=${path.basename(newest.filePath)}`;
  } else {
    reason = 'workspace matches found but all are already claimed';
  }
  if (codexNoMatchReasonByAgentId.get(agent.id) === reason) {
    return;
  }
  codexNoMatchReasonByAgentId.set(agent.id, reason);
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
  sessionInfo: CodexSessionInfo | undefined,
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
  agent.codexSessionId = sessionInfo.sessionId;
  agent.claimedJsonlFile = sessionInfo.normalizedFilePath;
  claimedJsonlFiles.set(sessionInfo.normalizedFilePath, agent.id);
  claimedCodexSessions.set(sessionInfo.sessionId, agent.id);
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
  sessionInfo?: CodexSessionInfo,
): void {
  const id = nextAgentIdRef.current++;
  const agent: AgentState = {
    id,
    provider,
    terminalRef: terminal,
    workspacePath: sessionInfo?.cwd,
    codexSessionId: sessionInfo?.sessionId,
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
    permissionSent: false,
    hadToolsInTurn: false,
    codexHasMeaningfulActivity: false,
  };

  applySessionClaim(agent, sessionInfo, claimedJsonlFiles, claimedCodexSessions);
  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
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
  sessionInfo?: CodexSessionInfo,
): void {
  const agent = agents.get(agentId);
  if (!agent) {
    return;
  }

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
  clearAgentActivity(
    agent,
    agentId,
    permissionTimers,
    webview,
    agent.provider === AGENT_PROVIDER_IDS.CODEX ? { status: 'none' } : undefined,
  );

  agent.jsonlFile = newFilePath;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  applySessionClaim(agent, sessionInfo, claimedJsonlFiles, claimedCodexSessions);
  persistAgents();

  startFileWatching(agentId, newFilePath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
  readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
}
