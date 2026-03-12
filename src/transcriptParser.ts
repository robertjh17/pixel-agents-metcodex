import * as path from 'path';
import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import {
  cancelWaitingTimer,
  startWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  cancelPermissionTimer,
} from './timerManager.js';
import {
  TOOL_DONE_DELAY_MS,
  TEXT_IDLE_DELAY_MS,
  COPILOT_TURN_IDLE_DELAY_MS,
  COPILOT_NARRATION_TOOL_ID,
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from './constants.js';

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'Agent', 'AskUserQuestion']);

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (filePath: unknown) => (typeof filePath === 'string' ? path.basename(filePath) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(input.file_path)}`;
    case 'Edit':
      return `Editing ${base(input.file_path)}`;
    case 'Write':
      return `Writing ${base(input.file_path)}`;
    case 'Bash': {
      const cmd = (input.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return desc || 'Planning';
    }
    case 'NotebookEdit':
      return 'Editing notebook';
    default:
      return `Using ${toolName}`;
  }
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): { clearPermission: boolean } {
  const agent = agents.get(agentId);
  if (!agent) {
    return { clearPermission: false };
  }

  const effects = { clearPermission: false };
  try {
    const record = JSON.parse(line) as Record<string, unknown>;

    if (record.type === 'assistant' && Array.isArray((record.message as { content?: unknown } | undefined)?.content)) {
      processClaudeAssistantRecord(agentId, record, agent, agents, waitingTimers, permissionTimers, webview);
      effects.clearPermission = true;
    } else if (record.type === 'progress') {
      processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers, webview);
      effects.clearPermission = true;
    } else if (record.type === 'user') {
      processClaudeUserRecord(agentId, record, agent, waitingTimers, permissionTimers, webview);
      effects.clearPermission = true;
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      markAgentWaiting(agentId, agent, waitingTimers, permissionTimers, webview);
    } else if (record.type === 'response_item') {
      effects.clearPermission = processCodexResponseItem(
        agentId,
        record,
        agent,
        agents,
        waitingTimers,
        permissionTimers,
        webview,
      ).clearPermission;
    } else if (record.type === 'event_msg') {
      effects.clearPermission = processCodexEvent(
        agentId,
        record,
        agent,
        agents,
        waitingTimers,
        permissionTimers,
        webview,
      ).clearPermission;
    } else if (
      record.type === 'assistant.turn_start' ||
      record.type === 'assistant.turn_end' ||
      record.type === 'assistant.message' ||
      record.type === 'tool.execution_start' ||
      record.type === 'tool.execution_complete' ||
      record.type === 'user.message' ||
      record.type === 'subagent.started' ||
      record.type === 'subagent.completed'
    ) {
      effects.clearPermission = processCopilotEvent(
        agentId,
        record,
        agent,
        agents,
        waitingTimers,
        permissionTimers,
        webview,
      ).clearPermission;
    }
  } catch {
    /* ignore malformed lines */
  }

  return effects;
}

function processClaudeAssistantRecord(
  agentId: number,
  record: Record<string, unknown>,
  agent: AgentState,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const message = record.message as { content?: unknown } | undefined;
  const blocks = message?.content as Array<{
    type: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  const hasToolUse = blocks.some((block) => block.type === 'tool_use');

  if (hasToolUse) {
    cancelWaitingTimer(agentId, waitingTimers);
    agent.isWaiting = false;
    agent.currentStatus = 'active';
    agent.hadToolsInTurn = true;
    webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });

    let hasNonExemptTool = false;
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id) {
        const toolName = block.name || '';
        const status = formatToolStatus(toolName, block.input || {});
        agent.activeToolIds.add(block.id);
        agent.activeToolStatuses.set(block.id, status);
        agent.activeToolNames.set(block.id, toolName);
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExemptTool = true;
        }
        webview?.postMessage({
          type: 'agentToolStart',
          id: agentId,
          toolId: block.id,
          status,
        });
      }
    }

    if (hasNonExemptTool) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
  } else if (blocks.some((block) => block.type === 'text') && !agent.hadToolsInTurn) {
    startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
  }
}

function processClaudeUserRecord(
  agentId: number,
  record: Record<string, unknown>,
  agent: AgentState,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    const blocks = content as Array<{ type: string; tool_use_id?: string }>;
    const hasToolResult = blocks.some((block) => block.type === 'tool_result');
    if (hasToolResult) {
      for (const block of blocks) {
        if (block.type !== 'tool_result' || !block.tool_use_id) {
          continue;
        }
        const completedToolId = block.tool_use_id;
        const completedToolName = agent.activeToolNames.get(completedToolId);
        if (completedToolName === 'Task' || completedToolName === 'Agent') {
          agent.activeSubagentToolIds.delete(completedToolId);
          agent.activeSubagentToolNames.delete(completedToolId);
          webview?.postMessage({
            type: 'subagentClear',
            id: agentId,
            parentToolId: completedToolId,
          });
        }
        agent.activeToolIds.delete(completedToolId);
        agent.activeToolStatuses.delete(completedToolId);
        agent.activeToolNames.delete(completedToolId);
        setTimeout(() => {
          webview?.postMessage({
            type: 'agentToolDone',
            id: agentId,
            toolId: completedToolId,
          });
        }, TOOL_DONE_DELAY_MS);
      }
      if (agent.activeToolIds.size === 0) {
        agent.hadToolsInTurn = false;
      }
    } else {
      cancelWaitingTimer(agentId, waitingTimers);
      clearAgentActivity(agent, agentId, permissionTimers, webview);
      agent.hadToolsInTurn = false;
    }
  } else if (typeof content === 'string' && content.trim()) {
    cancelWaitingTimer(agentId, waitingTimers);
    clearAgentActivity(agent, agentId, permissionTimers, webview);
    agent.hadToolsInTurn = false;
  }
}

function processCodexResponseItem(
  agentId: number,
  record: Record<string, unknown>,
  agent: AgentState,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): { clearPermission: boolean } {
  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload) {
    return { clearPermission: false };
  }

  if (payload.type === 'function_call') {
    const toolId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    if (!toolId) {
      return { clearPermission: false };
    }
    const { toolName, input } = getCodexToolDetails(payload);
    const status = formatToolStatus(toolName, input);
    markCodexActive(agentId, agent, waitingTimers, webview);
    agent.hadToolsInTurn = true;
    agent.codexHasMeaningfulActivity = true;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, status);
    agent.activeToolNames.set(toolId, toolName);
    webview?.postMessage({ type: 'agentToolStart', id: agentId, toolId, status });
    if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
    return { clearPermission: true };
  }

  if (payload.type === 'function_call_output') {
    const toolId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    if (!toolId) {
      return { clearPermission: false };
    }
    agent.activeToolIds.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    agent.activeToolNames.delete(toolId);
    setTimeout(() => {
      webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId });
    }, TOOL_DONE_DELAY_MS);
    if (agent.activeToolIds.size === 0) {
      agent.hadToolsInTurn = false;
      startCodexIdleTimer(agentId, agent, agents, waitingTimers, permissionTimers, webview);
    }
    return { clearPermission: true };
  }

  if (payload.type === 'reasoning' || (payload.type === 'message' && payload.role === 'assistant')) {
    markCodexActive(agentId, agent, waitingTimers, webview);
    agent.codexHasMeaningfulActivity = true;
    startCodexIdleTimer(agentId, agent, agents, waitingTimers, permissionTimers, webview);
    return { clearPermission: true };
  }

  if (payload.type === 'message' && payload.role === 'user') {
    agent.codexHasMeaningfulActivity = false;
    return { clearPermission: true };
  }

  return { clearPermission: false };
}

function processCodexEvent(
  agentId: number,
  record: Record<string, unknown>,
  agent: AgentState,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): { clearPermission: boolean } {
  const payload = record.payload as Record<string, unknown> | undefined;
  const eventType = payload?.type;
  if (eventType === 'task_started' || eventType === 'agent_message') {
    markCodexActive(agentId, agent, waitingTimers, webview);
    agent.codexHasMeaningfulActivity = true;
    if (eventType === 'agent_message' && agent.activeToolIds.size === 0) {
      startCodexIdleTimer(agentId, agent, agents, waitingTimers, permissionTimers, webview);
    }
    return { clearPermission: true };
  }
  if (eventType === 'task_complete') {
    markAgentWaiting(agentId, agent, waitingTimers, permissionTimers, webview);
    return { clearPermission: false };
  }
  return { clearPermission: false };
}

function processCopilotEvent(
	agentId: number,
	record: Record<string, unknown>,
	agent: AgentState,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): { clearPermission: boolean } {
	const data = record.data as Record<string, unknown> | undefined;
	touchCopilotActivity(agent);
	switch (record.type) {
		case 'assistant.turn_start':
			markCopilotActive(agentId, agent, waitingTimers, webview);
			return { clearPermission: true };
		case 'assistant.turn_end':
			scheduleCopilotTurnEndCheck(agentId, agent, agents, waitingTimers, permissionTimers, webview);
			return { clearPermission: true };
		case 'assistant.message': {
			const toolRequests = Array.isArray(data?.toolRequests) ? data.toolRequests : [];
			const parentToolId = typeof data?.parentToolCallId === 'string' ? data.parentToolCallId : undefined;
			const askUserRequest = toolRequests.find(request => getCopilotToolDisplayName(getCopilotToolRequestName(request)) === 'AskUserQuestion');
			if (askUserRequest) {
				showCopilotNeedsInput(agentId, agent, getCopilotAskUserText(askUserRequest), waitingTimers, permissionTimers, webview, getCopilotToolRequestId(askUserRequest));
				return { clearPermission: true };
			}
			if (toolRequests.length > 0) {
				clearCopilotNarration(agentId, agent, webview, parentToolId);
				markCopilotActive(agentId, agent, waitingTimers, webview);
				agent.hadToolsInTurn = true;
				return { clearPermission: true };
			}
			const narration = extractCopilotNarration(data);
			if (!narration) {
				return { clearPermission: false };
			}
			if (parentToolId && agent.copilotSubagents.has(parentToolId)) {
				upsertCopilotSubagentNarration(agentId, agent, parentToolId, narration, webview);
			} else {
				upsertCopilotNarration(agentId, agent, narration, waitingTimers, webview);
			}
			return { clearPermission: true };
		}
		case 'tool.execution_start': {
			const toolId = typeof data?.toolCallId === 'string' ? data.toolCallId : undefined;
			const toolName = typeof data?.toolName === 'string' ? data.toolName : undefined;
			if (!toolId || !toolName) {
				return { clearPermission: false };
			}
			const parentToolId = typeof data?.parentToolCallId === 'string' ? data.parentToolCallId : undefined;
			const displayName = getCopilotToolDisplayName(toolName);
			const status = formatToolStatus(displayName, getCopilotToolInput(toolName, data?.arguments));
			clearCopilotNarration(agentId, agent, webview, parentToolId);
			if (displayName === 'AskUserQuestion') {
				showCopilotNeedsInput(agentId, agent, getCopilotAskUserText(data?.arguments), waitingTimers, permissionTimers, webview, toolId);
			} else {
				markCopilotActive(agentId, agent, waitingTimers, webview);
			}
			agent.hadToolsInTurn = true;
			if (parentToolId && agent.copilotSubagents.has(parentToolId)) {
				registerCopilotChildTool(agent, parentToolId, toolId, toolName);
				console.log(`[Pixel Agents] Agent ${agentId} Copilot subagent tool start: ${toolId} ${status} (parent: ${parentToolId})`);
				webview?.postMessage({ type: 'subagentToolStart', id: agentId, parentToolId, toolId, status });
			} else {
				agent.activeToolIds.add(toolId);
				agent.activeToolStatuses.set(toolId, status);
				agent.activeToolNames.set(toolId, toolName);
				if (displayName === 'Task') {
					agent.copilotActiveParentToolIds.add(toolId);
				}
				console.log(`[Pixel Agents] Agent ${agentId} Copilot tool start: ${toolId} ${status}`);
				webview?.postMessage({ type: 'agentToolStart', id: agentId, toolId, status });
			}
			if (!PERMISSION_EXEMPT_TOOLS.has(displayName)) {
				startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
			}
			return { clearPermission: true };
		}
		case 'tool.execution_complete': {
			const toolId = typeof data?.toolCallId === 'string' ? data.toolCallId : undefined;
			if (!toolId) {
				return { clearPermission: false };
			}
			const parentToolId = typeof data?.parentToolCallId === 'string' ? data.parentToolCallId : undefined;
			if (parentToolId && agent.copilotSubagents.has(parentToolId)) {
				console.log(`[Pixel Agents] Agent ${agentId} Copilot subagent tool done: ${toolId} (parent: ${parentToolId})`);
				clearCopilotChildTool(agent, parentToolId, toolId);
				setTimeout(() => {
					webview?.postMessage({ type: 'subagentToolDone', id: agentId, parentToolId, toolId });
				}, TOOL_DONE_DELAY_MS);
				clearCopilotSubagentIfFinished(agentId, agent, parentToolId, webview);
			} else {
				console.log(`[Pixel Agents] Agent ${agentId} Copilot tool done: ${toolId}`);
				agent.activeToolIds.delete(toolId);
				agent.activeToolStatuses.delete(toolId);
				agent.activeToolNames.delete(toolId);
				agent.copilotActiveParentToolIds.delete(toolId);
				setTimeout(() => {
					webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId });
				}, TOOL_DONE_DELAY_MS);
				clearCopilotSubagentIfFinished(agentId, agent, toolId, webview);
			}
			if (!hasCopilotActivity(agent)) {
				agent.hadToolsInTurn = false;
				scheduleCopilotTurnEndCheck(agentId, agent, agents, waitingTimers, permissionTimers, webview);
			} else {
				startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
			}
			return { clearPermission: true };
		}
		case 'subagent.started': {
			const parentToolId = typeof data?.parentToolCallId === 'string' ? data.parentToolCallId : undefined;
			if (!parentToolId) {
				return { clearPermission: false };
			}
			const label = extractCopilotSubagentLabel(data) ?? agent.activeToolStatuses.get(parentToolId) ?? 'Running subtask';
			agent.copilotSubagents.set(parentToolId, { label, completed: false });
			return { clearPermission: true };
		}
		case 'subagent.completed': {
			const parentToolId = typeof data?.parentToolCallId === 'string' ? data.parentToolCallId : undefined;
			if (!parentToolId) {
				return { clearPermission: false };
			}
			const meta = agent.copilotSubagents.get(parentToolId);
			if (meta) {
				meta.completed = true;
			}
			clearCopilotSubagentIfFinished(agentId, agent, parentToolId, webview);
			if (!hasCopilotActivity(agent)) {
				scheduleCopilotTurnEndCheck(agentId, agent, agents, waitingTimers, permissionTimers, webview);
			}
			return { clearPermission: true };
		}
		case 'user.message':
			cancelWaitingTimer(agentId, waitingTimers);
			clearCopilotPendingTurnEnd(agent);
			clearAgentActivity(agent, agentId, permissionTimers, webview, { status: 'none' });
			agent.hadToolsInTurn = false;
			return { clearPermission: true };
		default:
			return { clearPermission: false };
	}
}

function getCodexToolDetails(payload: Record<string, unknown>): { toolName: string; input: Record<string, unknown> } {
  const name = typeof payload.name === 'string' ? payload.name : 'Unknown';
  const input = parseCodexArguments(payload.arguments);
  if (name === 'shell_command') {
    return { toolName: 'Bash', input: { command: input.command } };
  }
  if (name === 'apply_patch') {
    return { toolName: 'Edit', input: { file_path: 'patch' } };
  }
  if (name === 'multi_tool_use.parallel') {
    return { toolName: 'Task', input: { description: 'Running parallel tools' } };
  }
  return { toolName: name, input };
}

function getCopilotToolDisplayName(toolName: string): string {
	switch (toolName) {
		case 'view':
		case 'view_range':
		case 'cat':
			return 'Read';
		case 'create':
			return 'Write';
		case 'insert':
		case 'str_replace':
		case 'replace':
			return 'Edit';
		case 'glob':
			return 'Glob';
		case 'grep':
		case 'search':
			return 'Grep';
		case 'powershell':
		case 'bash':
			return 'Bash';
		case 'report_intent':
			return 'EnterPlanMode';
		case 'task':
			return 'Task';
		case 'ask_user':
		case 'askUser':
		case 'ask_user_question':
		case 'AskUserQuestion':
			return 'AskUserQuestion';
		case 'open':
			return 'Read';
		default:
			return toolName;
	}
}

function getCopilotToolInput(toolName: string, rawArguments: unknown): Record<string, unknown> {
	if (typeof rawArguments !== 'object' || rawArguments === null) {
		return {};
	}
	const args = rawArguments as Record<string, unknown>;
	switch (toolName) {
		case 'view':
		case 'view_range':
		case 'cat':
			return { file_path: args.path };
		case 'create':
			return { file_path: args.path };
		case 'insert':
		case 'str_replace':
		case 'replace':
			return { file_path: args.path };
		case 'powershell':
		case 'bash':
			return { command: args.command };
		case 'glob':
			return { pattern: args.pattern };
		case 'grep':
		case 'search':
			return { pattern: args.pattern };
		case 'report_intent':
			return { description: args.intent };
		case 'task':
			return { description: args.description ?? args.prompt ?? args.subtask };
		case 'ask_user':
		case 'askUser':
		case 'ask_user_question':
		case 'AskUserQuestion':
			return { description: args.question ?? args.prompt ?? args.message };
		case 'open':
			return { file_path: args.path };
		default:
			return args;
	}
}

function parseCodexArguments(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments !== 'string' || !rawArguments.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawArguments);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { command: rawArguments };
  }
}

function markAgentWaiting(
  agentId: number,
  agent: AgentState,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  clearCopilotPendingTurnEnd(agent);

  if (
    agent.activeToolIds.size > 0 ||
    agent.activeSubagentToolIds.size > 0 ||
    agent.copilotSubagents.size > 0 ||
    agent.copilotActiveChildToolIdsByParent.size > 0
  ) {
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
    agent.copilotActiveParentToolIds.clear();
    agent.copilotActiveChildToolIdsByParent.clear();
    agent.copilotSubagents.clear();
    agent.copilotNarrationStatus = undefined;
    webview?.postMessage({ type: 'agentToolsClear', id: agentId });
  }

  agent.isWaiting = true;
  agent.currentStatus = 'waiting';
  agent.permissionSent = false;
  agent.hadToolsInTurn = false;
  agent.codexHasMeaningfulActivity = false;
  webview?.postMessage({
    type: 'agentStatus',
    id: agentId,
    status: 'waiting',
  });
}

function markCodexActive(
  agentId: number,
  agent: AgentState,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  cancelWaitingTimer(agentId, waitingTimers);
  agent.isWaiting = false;
  agent.currentStatus = 'active';
  webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
}

function markCopilotActive(
	agentId: number,
	agent: AgentState,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	cancelWaitingTimer(agentId, waitingTimers);
	clearCopilotPendingTurnEnd(agent);
	agent.isWaiting = false;
	agent.currentStatus = 'active';
	webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
}

function touchCopilotActivity(agent: AgentState): void {
	agent.copilotLastAssistantActivityAt = Date.now();
	clearCopilotPendingTurnEnd(agent);
}

function clearCopilotPendingTurnEnd(agent: AgentState): void {
	if (agent.copilotPendingTurnEndTimer) {
		clearTimeout(agent.copilotPendingTurnEndTimer);
		agent.copilotPendingTurnEndTimer = undefined;
	}
}

function hasCopilotActivity(agent: AgentState): boolean {
	if (agent.activeToolIds.size > 0) {
		return true;
	}
	if (agent.copilotNarrationStatus) {
		return true;
	}
	for (const childIds of agent.copilotActiveChildToolIdsByParent.values()) {
		if (childIds.size > 0) {
			return true;
		}
	}
	for (const meta of agent.copilotSubagents.values()) {
		if (!meta.completed) {
			return true;
		}
	}
	return false;
}

function scheduleCopilotTurnEndCheck(
	agentId: number,
	agent: AgentState,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	clearCopilotPendingTurnEnd(agent);
	agent.copilotPendingTurnEndTimer = setTimeout(() => {
		agent.copilotPendingTurnEndTimer = undefined;
		const liveAgent = agents.get(agentId);
		if (!liveAgent || hasCopilotActivity(liveAgent)) {
			return;
		}
		markAgentWaiting(agentId, liveAgent, waitingTimers, permissionTimers, webview);
	}, COPILOT_TURN_IDLE_DELAY_MS);
}

function upsertCopilotNarration(
	agentId: number,
	agent: AgentState,
	status: string,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	markCopilotActive(agentId, agent, waitingTimers, webview);
	agent.copilotNarrationStatus = status;
	agent.activeToolIds.add(COPILOT_NARRATION_TOOL_ID);
	agent.activeToolStatuses.set(COPILOT_NARRATION_TOOL_ID, status);
	agent.activeToolNames.set(COPILOT_NARRATION_TOOL_ID, 'Narration');
	webview?.postMessage({ type: 'agentToolStart', id: agentId, toolId: COPILOT_NARRATION_TOOL_ID, status });
}

function upsertCopilotSubagentNarration(
	agentId: number,
	agent: AgentState,
	parentToolId: string,
	status: string,
	webview: vscode.Webview | undefined,
): void {
	const narrationToolId = `${COPILOT_NARRATION_TOOL_ID}:${parentToolId}`;
	registerCopilotChildTool(agent, parentToolId, narrationToolId, 'Narration');
	webview?.postMessage({ type: 'subagentToolStart', id: agentId, parentToolId, toolId: narrationToolId, status });
}

function clearCopilotNarration(
	agentId: number,
	agent: AgentState,
	webview: vscode.Webview | undefined,
	parentToolId?: string,
): void {
	if (parentToolId) {
		const narrationToolId = `${COPILOT_NARRATION_TOOL_ID}:${parentToolId}`;
		const childIds = agent.copilotActiveChildToolIdsByParent.get(parentToolId);
		if (!childIds?.has(narrationToolId)) {
			return;
		}
		clearCopilotChildTool(agent, parentToolId, narrationToolId);
		webview?.postMessage({ type: 'subagentToolDone', id: agentId, parentToolId, toolId: narrationToolId });
		return;
	}
	if (!agent.activeToolIds.has(COPILOT_NARRATION_TOOL_ID)) {
		return;
	}
	agent.copilotNarrationStatus = undefined;
	agent.activeToolIds.delete(COPILOT_NARRATION_TOOL_ID);
	agent.activeToolStatuses.delete(COPILOT_NARRATION_TOOL_ID);
	agent.activeToolNames.delete(COPILOT_NARRATION_TOOL_ID);
	webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId: COPILOT_NARRATION_TOOL_ID });
}

function registerCopilotChildTool(
	agent: AgentState,
	parentToolId: string,
	toolId: string,
	toolName: string,
): void {
	let childIds = agent.copilotActiveChildToolIdsByParent.get(parentToolId);
	if (!childIds) {
		childIds = new Set();
		agent.copilotActiveChildToolIdsByParent.set(parentToolId, childIds);
	}
	childIds.add(toolId);

	let subTools = agent.activeSubagentToolIds.get(parentToolId);
	if (!subTools) {
		subTools = new Set();
		agent.activeSubagentToolIds.set(parentToolId, subTools);
	}
	subTools.add(toolId);

	let subNames = agent.activeSubagentToolNames.get(parentToolId);
	if (!subNames) {
		subNames = new Map();
		agent.activeSubagentToolNames.set(parentToolId, subNames);
	}
	subNames.set(toolId, toolName);
}

function clearCopilotChildTool(
	agent: AgentState,
	parentToolId: string,
	toolId: string,
): void {
	const childIds = agent.copilotActiveChildToolIdsByParent.get(parentToolId);
	childIds?.delete(toolId);
	if (childIds?.size === 0) {
		agent.copilotActiveChildToolIdsByParent.delete(parentToolId);
	}

	const subTools = agent.activeSubagentToolIds.get(parentToolId);
	subTools?.delete(toolId);
	if (subTools?.size === 0) {
		agent.activeSubagentToolIds.delete(parentToolId);
	}

	const subNames = agent.activeSubagentToolNames.get(parentToolId);
	subNames?.delete(toolId);
	if (subNames?.size === 0) {
		agent.activeSubagentToolNames.delete(parentToolId);
	}
}

function clearCopilotSubagentIfFinished(
	agentId: number,
	agent: AgentState,
	parentToolId: string,
	webview: vscode.Webview | undefined,
): void {
	const childIds = agent.copilotActiveChildToolIdsByParent.get(parentToolId);
	const meta = agent.copilotSubagents.get(parentToolId);
	if ((childIds?.size ?? 0) > 0) {
		return;
	}
	if (agent.copilotActiveParentToolIds.has(parentToolId) || !meta?.completed) {
		return;
	}
	agent.copilotSubagents.delete(parentToolId);
	agent.activeSubagentToolIds.delete(parentToolId);
	agent.activeSubagentToolNames.delete(parentToolId);
	webview?.postMessage({ type: 'subagentClear', id: agentId, parentToolId });
}

function showCopilotNeedsInput(
	agentId: number,
	agent: AgentState,
	question: string | undefined,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	toolId = 'copilot-ask-user',
): void {
	cancelWaitingTimer(agentId, waitingTimers);
	clearCopilotPendingTurnEnd(agent);
	cancelPermissionTimer(agentId, permissionTimers);
	agent.isWaiting = true;
	agent.currentStatus = 'needsInput';
	if (toolId !== 'copilot-ask-user' && agent.activeToolIds.has('copilot-ask-user')) {
		agent.activeToolIds.delete('copilot-ask-user');
		agent.activeToolStatuses.delete('copilot-ask-user');
		agent.activeToolNames.delete('copilot-ask-user');
		webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId: 'copilot-ask-user' });
	}
	const status = question ? `Waiting for your answer: ${question}` : 'Waiting for your answer';
	agent.activeToolIds.add(toolId);
	agent.activeToolStatuses.set(toolId, status);
	agent.activeToolNames.set(toolId, 'AskUserQuestion');
	webview?.postMessage({ type: 'agentToolStart', id: agentId, toolId, status });
	webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'needsInput' });
}

function extractCopilotNarration(data: Record<string, unknown> | undefined): string | undefined {
	const reasoning = typeof data?.reasoningText === 'string' ? data.reasoningText.trim() : '';
	if (reasoning) {
		return reasoning;
	}
	const content = data?.content;
	if (typeof content === 'string' && content.trim()) {
		return content.trim();
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	for (const item of content) {
		if (typeof item === 'string' && item.trim()) {
			return item.trim();
		}
		if (typeof item === 'object' && item !== null) {
			const text = (item as Record<string, unknown>).text;
			if (typeof text === 'string' && text.trim()) {
				return text.trim();
			}
		}
	}
	return undefined;
}

function getCopilotToolRequestName(request: unknown): string {
	if (typeof request !== 'object' || request === null) {
		return '';
	}
	const record = request as Record<string, unknown>;
	if (typeof record.name === 'string') {
		return record.name;
	}
	if (typeof record.toolName === 'string') {
		return record.toolName;
	}
	return '';
}

function getCopilotToolRequestId(request: unknown): string | undefined {
	if (typeof request !== 'object' || request === null) {
		return undefined;
	}
	const record = request as Record<string, unknown>;
	if (typeof record.toolCallId === 'string') {
		return record.toolCallId;
	}
	if (typeof record.id === 'string') {
		return record.id;
	}
	return undefined;
}

function getCopilotAskUserText(raw: unknown): string | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const argumentsObject = typeof record.arguments === 'object' && record.arguments !== null
		? record.arguments as Record<string, unknown>
		: record;
	const value = argumentsObject.question ?? argumentsObject.prompt ?? argumentsObject.message;
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractCopilotSubagentLabel(data: Record<string, unknown> | undefined): string | undefined {
	const description = typeof data?.description === 'string' ? data.description.trim() : '';
	if (description) {
		return description;
	}
	const prompt = typeof data?.prompt === 'string' ? data.prompt.trim() : '';
	return prompt || undefined;
}

function startCodexIdleTimer(
  agentId: number,
  agent: AgentState,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  if (agent.activeToolIds.size > 0 || !agent.codexHasMeaningfulActivity) {
    return;
  }
  startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
  cancelPermissionTimer(agentId, permissionTimers);
}

function processProgressRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) {
    return;
  }

  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) {
    return;
  }

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) {
    return;
  }

  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    if (agent.activeToolIds.has(parentToolId)) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
    return;
  }

  const parentToolName = agent.activeToolNames.get(parentToolId);
  if (parentToolName !== 'Task' && parentToolName !== 'Agent') {
    return;
  }

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) {
    return;
  }

  const msgType = msg.type as string;
  const innerMsg = msg.message as Record<string, unknown> | undefined;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) {
    return;
  }

  if (msgType === 'assistant') {
    let hasNonExemptSubTool = false;
    for (const block of content) {
      if (block.type !== 'tool_use' || !block.id) {
        continue;
      }
      const toolName = block.name || '';
      const status = formatToolStatus(toolName, block.input || {});

      let subTools = agent.activeSubagentToolIds.get(parentToolId);
      if (!subTools) {
        subTools = new Set();
        agent.activeSubagentToolIds.set(parentToolId, subTools);
      }
      subTools.add(block.id);

      let subNames = agent.activeSubagentToolNames.get(parentToolId);
      if (!subNames) {
        subNames = new Map();
        agent.activeSubagentToolNames.set(parentToolId, subNames);
      }
      subNames.set(block.id, toolName);

      if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
        hasNonExemptSubTool = true;
      }

      webview?.postMessage({
        type: 'subagentToolStart',
        id: agentId,
        parentToolId,
        toolId: block.id,
        status,
      });
    }
    if (hasNonExemptSubTool) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
  } else if (msgType === 'user') {
    for (const block of content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) {
        continue;
      }

      const subTools = agent.activeSubagentToolIds.get(parentToolId);
      if (subTools) {
        subTools.delete(block.tool_use_id);
      }
      const subNames = agent.activeSubagentToolNames.get(parentToolId);
      if (subNames) {
        subNames.delete(block.tool_use_id);
      }

      const toolId = block.tool_use_id;
      setTimeout(() => {
        webview?.postMessage({
          type: 'subagentToolDone',
          id: agentId,
          parentToolId,
          toolId,
        });
      }, TOOL_DONE_DELAY_MS);
    }

    let stillHasNonExempt = false;
    for (const [, subNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subNames) {
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          stillHasNonExempt = true;
          break;
        }
      }
      if (stillHasNonExempt) {
        break;
      }
    }
    if (stillHasNonExempt) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
  }
}
