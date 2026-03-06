# Pixel Agents Reference

## Overview

VS Code extension with an embedded React webview that renders a pixel art office. Claude Code and Codex terminals are represented as animated characters.

## Core Concepts

- Terminal: a VS Code terminal running Claude Code or Codex
- Session: a JSONL transcript file
- Agent: the in-office character mapped to one terminal

## Key Backend Files

- `src/PixelAgentsViewProvider.ts`: webview lifecycle, message routing, assets, restore/close flows
- `src/agentManager.ts`: launch, restore, persist, remove agents
- `src/fileWatcher.ts`: JSONL watching, project scans, adoption, `/clear`, Codex session claiming
- `src/transcriptParser.ts`: Claude and Codex transcript parsing into webview events
- `src/providers.ts`: provider registry and session-root resolution
- `src/layoutPersistence.ts`: shared layout file persistence and migration

## Provider Model

- `claude`
  - launched with `claude --session-id <uuid>`
  - transcripts live under `~/.claude/projects/<project-hash>/`
- `codex`
  - launched with `codex`
  - transcripts are discovered from Codex session directories
  - session claiming uses `codexSessionId` plus normalized JSONL paths

## Webview Messages

- `openAgent`
- `agentCreated`
- `agentClosed`
- `focusAgent`
- `agentToolStart`
- `agentToolDone`
- `agentStatus`
- `existingAgents`
- `layoutLoaded`
- `saveLayout`
- `saveAgentSeats`
- `settingsLoaded`

## Important Invariants

- Codex support must never regress behind Claude-only assumptions.
- Claude restore and `/clear` handling must keep working.
- Agent persistence must remain backward-compatible when old saved agents lack `provider`.
- Layout persistence and asset loading must keep working regardless of provider changes.

## Build

```bash
npm install
cd webview-ui
npm install
cd ..
npm run build
```
