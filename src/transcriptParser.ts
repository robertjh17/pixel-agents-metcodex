import * as path from 'path';
import type * as vscode from 'vscode';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from './constants.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';

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
    case 'EnterPlanMode':
      return 'Planning';
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
    agent.hadToolsInTurn = true;
    webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });

    let hasNonExemptTool = false;
    for (const block of blocks) {
      if (block.type !== 'tool_use' || !block.id) {
        continue;
      }
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

  if (agent.activeToolIds.size > 0) {
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
    webview?.postMessage({ type: 'agentToolsClear', id: agentId });
  }

  agent.isWaiting = true;
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
  webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
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
