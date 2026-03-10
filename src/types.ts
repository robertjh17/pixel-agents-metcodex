import type * as vscode from 'vscode';
import type { AgentProviderId } from './providers.js';

export interface AgentState {
	id: number;
	provider: AgentProviderId;
	terminalRef: vscode.Terminal;
	workspacePath?: string;
	launchTimeMs?: number;
	codexSessionId?: string;
	claimedJsonlFile?: string;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId -> active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId -> (subToolId -> toolName)
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	codexHasMeaningfulActivity: boolean;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
}

export interface PersistedAgent {
	id: number;
	provider?: AgentProviderId;
	terminalName: string;
	workspacePath?: string;
	launchTimeMs?: number;
	codexSessionId?: string;
	claimedJsonlFile?: string;
	jsonlFile: string;
	projectDir: string;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
}
