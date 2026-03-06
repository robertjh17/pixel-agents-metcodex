import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const AGENT_PROVIDER_IDS = {
	CLAUDE: 'claude',
	CODEX: 'codex',
} as const;

export type AgentProviderId = typeof AGENT_PROVIDER_IDS[keyof typeof AGENT_PROVIDER_IDS];

export interface AgentProvider {
	id: AgentProviderId;
	label: string;
	terminalNamePrefix: string;
	command: string;
	supportsSessionId: boolean;
	sessionRootDirNames: readonly string[];
}

export const AGENT_PROVIDERS: Record<AgentProviderId, AgentProvider> = {
	[AGENT_PROVIDER_IDS.CLAUDE]: {
		id: AGENT_PROVIDER_IDS.CLAUDE,
		label: 'Claude',
		terminalNamePrefix: 'Claude Code',
		command: 'claude',
		supportsSessionId: true,
		sessionRootDirNames: ['.claude'],
	},
	[AGENT_PROVIDER_IDS.CODEX]: {
		id: AGENT_PROVIDER_IDS.CODEX,
		label: 'Codex',
		terminalNamePrefix: 'Codex',
		command: 'codex',
		supportsSessionId: false,
		sessionRootDirNames: ['.codex', '.Codex'],
	},
};

export function getAgentProvider(providerId: AgentProviderId): AgentProvider {
	return AGENT_PROVIDERS[providerId];
}

export function isAgentProviderId(value: unknown): value is AgentProviderId {
	return value === AGENT_PROVIDER_IDS.CLAUDE || value === AGENT_PROVIDER_IDS.CODEX;
}

export function resolveSessionRootDirs(providerId: AgentProviderId): string[] {
	const provider = getAgentProvider(providerId);
	const withProjects: string[] = [];
	const existingRoots: string[] = [];
	const fallbackRoots: string[] = [];

	for (const dirName of provider.sessionRootDirNames) {
		const rootDir = path.join(os.homedir(), dirName);
		const projectsDir = path.join(rootDir, 'projects');
		try {
			if (fs.existsSync(projectsDir)) {
				withProjects.push(rootDir);
				continue;
			}
			if (fs.existsSync(rootDir)) {
				existingRoots.push(rootDir);
				continue;
			}
		} catch {
			// Ignore inaccessible paths and keep them as fallbacks.
		}
		fallbackRoots.push(rootDir);
	}

	return [...new Set([...withProjects, ...existingRoots, ...fallbackRoots])];
}
