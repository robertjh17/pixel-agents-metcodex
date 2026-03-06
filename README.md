# Pixel Agents

Pixel Agents is a VS Code extension that turns your AI terminals into animated characters inside a pixel art office. Each Claude Code or Codex terminal becomes its own agent in the scene, with live tool activity, waiting states, layout editing, and persistent office customization.

## Highlights

- One agent per terminal for both Claude Code and Codex
- Live tool/activity tracking from JSONL transcripts
- Office layout editor with floors, walls, furniture, export/import, and persistence
- Waiting / permission indicators plus optional sound notifications
- Sub-agent visualization for task workflows

## Requirements

- VS Code 1.109.0 or later
- Either [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) or Codex CLI installed and configured

## Getting Started

```bash
git clone https://github.com/pablodelucca/pixel-agents.git
cd pixel-agents
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Usage

1. Open the `Pixel Agents` panel.
2. Click `+ Agent`.
3. Choose `Claude` or `Codex`.
4. Start working in that terminal and watch the character react.
5. Use `Layout` to customize the office.

## Notes

- Layouts are persisted in `~/.pixel-agents/layout.json`.
- Agent state is restored from VS Code workspace state.
- Transcript watching supports both Claude-style and Codex-style JSONL flows.

## Development

- Extension backend: TypeScript + VS Code API
- Webview UI: React + TypeScript + Vite
- Build command: `npm run build`

## Vision

Pixel Agents is being built toward an agent-agnostic interface: Claude today, Codex now supported, and room for more providers in the future.
