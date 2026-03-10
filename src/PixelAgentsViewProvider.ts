import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  getProjectDirPaths,
  launchNewTerminal,
  persistAgents,
  removeAgent,
  restoreAgents,
  sendExistingAgents,
  sendLayout,
} from './agentManager.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadWallTiles,
  sendAssetsToWebview,
  sendCharacterSpritesToWebview,
  sendFloorTilesToWebview,
  sendWallTilesToWebview,
} from './assetLoader.js';
import { GLOBAL_KEY_SOUND_ENABLED, LAYOUT_REVISION_KEY, WORKSPACE_KEY_AGENT_SEATS } from './constants.js';
import { ensureProjectScan } from './fileWatcher.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { readLayoutFromFile, watchLayoutFile, writeLayoutToFile } from './layoutPersistence.js';
import type { AgentProviderId } from './providers.js';
import { AGENT_PROVIDER_IDS, AGENT_PROVIDERS, isAgentProviderId } from './providers.js';
import type { AgentState } from './types.js';

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
  nextAgentId = { current: 1 };
  nextTerminalIndex = { current: 1 };
  agents = new Map<number, AgentState>();
  webviewView: vscode.WebviewView | undefined;

  fileWatchers = new Map<number, fs.FSWatcher>();
  pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
  permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  activeAgentId = { current: null as number | null };
  knownJsonlFiles = new Set<string>();
  claimedJsonlFiles = new Map<string, number>();
  claimedCodexSessions = new Map<string, number>();
  projectScanTimers = new Map<string, ReturnType<typeof setInterval>>();

  defaultLayout: Record<string, unknown> | null = null;
  layoutWatcher: LayoutWatcher | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  private get webview(): vscode.Webview | undefined {
    return this.webviewView?.webview;
  }

  private persistAgents = (): void => {
    persistAgents(this.agents, this.context);
  };

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'openAgent') {
        const provider = isAgentProviderId(message.provider) ? message.provider : AGENT_PROVIDER_IDS.CLAUDE;
        await launchNewTerminal(
          this.nextAgentId,
          this.nextTerminalIndex,
          this.agents,
          this.activeAgentId,
          this.knownJsonlFiles,
          this.claimedJsonlFiles,
          this.claimedCodexSessions,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          this.jsonlPollTimers,
          this.projectScanTimers,
          this.webview,
          this.persistAgents,
          provider,
          message.folderPath as string | undefined,
        );
      } else if (message.type === 'focusAgent') {
        const agent = this.agents.get(message.id);
        if (agent) {
          agent.terminalRef.show();
        }
      } else if (message.type === 'closeAgent') {
        const agent = this.agents.get(message.id);
        if (agent) {
          agent.terminalRef.dispose();
        }
      } else if (message.type === 'saveAgentSeats') {
        console.log('[Pixel Agents] saveAgentSeats:', JSON.stringify(message.seats));
        this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
      } else if (message.type === 'saveLayout') {
        this.layoutWatcher?.markOwnWrite();
        writeLayoutToFile(message.layout as Record<string, unknown>);
      } else if (message.type === 'setSoundEnabled') {
        this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
      } else if (message.type === 'webviewReady') {
        restoreAgents(
          this.context,
          this.nextAgentId,
          this.nextTerminalIndex,
          this.agents,
          this.knownJsonlFiles,
          this.claimedJsonlFiles,
          this.claimedCodexSessions,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          this.jsonlPollTimers,
          this.projectScanTimers,
          this.activeAgentId,
          this.webview,
          this.persistAgents,
        );

        const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
        this.webview?.postMessage({ type: 'settingsLoaded', soundEnabled });

        const wsFolders = vscode.workspace.workspaceFolders;
        if (wsFolders && wsFolders.length > 1) {
          this.webview?.postMessage({
            type: 'workspaceFolders',
            folders: wsFolders.map((folder) => ({ name: folder.name, path: folder.uri.fsPath })),
          });
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        console.log('[Extension] workspaceRoot:', workspaceRoot);
        for (const providerId of Object.keys(AGENT_PROVIDERS) as AgentProviderId[]) {
          const projectDirs = getProjectDirPaths(providerId);
          console.log(`[Extension] ${providerId} projectDirs:`, projectDirs);
          for (const projectDir of projectDirs) {
            ensureProjectScan(
              providerId,
              projectDir,
              this.knownJsonlFiles,
              this.claimedJsonlFiles,
              this.claimedCodexSessions,
              this.projectScanTimers,
              this.activeAgentId,
              this.nextAgentId,
              this.agents,
              this.fileWatchers,
              this.pollingTimers,
              this.waitingTimers,
              this.permissionTimers,
              this.webview,
              this.persistAgents,
            );
          }
        }

        if (workspaceRoot) {
          void (async () => {
            try {
              console.log('[Extension] Loading furniture assets...');
              const extensionPath = this.extensionUri.fsPath;
              console.log('[Extension] extensionPath:', extensionPath);

              const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
              let assetsRoot: string | null = null;
              if (fs.existsSync(bundledAssetsDir)) {
                console.log('[Extension] Found bundled assets at dist/');
                assetsRoot = path.join(extensionPath, 'dist');
              } else {
                console.log('[Extension] Trying workspace for assets...');
                assetsRoot = workspaceRoot;
              }

              if (!assetsRoot) {
                console.log('[Extension] No assets directory found');
                if (this.webview) {
                  sendLayout(this.context, this.webview, this.defaultLayout);
                  this.startLayoutWatcher();
                }
                return;
              }

              console.log('[Extension] Using assetsRoot:', assetsRoot);

              this.defaultLayout = loadDefaultLayout(assetsRoot);

              const charSprites = await loadCharacterSprites(assetsRoot);
              if (charSprites && this.webview) {
                console.log('[Extension] Character sprites loaded, sending to webview');
                sendCharacterSpritesToWebview(this.webview, charSprites);
              }

              const floorTiles = await loadFloorTiles(assetsRoot);
              if (floorTiles && this.webview) {
                console.log('[Extension] Floor tiles loaded, sending to webview');
                sendFloorTilesToWebview(this.webview, floorTiles);
              }

              const wallTiles = await loadWallTiles(assetsRoot);
              if (wallTiles && this.webview) {
                console.log('[Extension] Wall tiles loaded, sending to webview');
                sendWallTilesToWebview(this.webview, wallTiles);
              }

              const assets = await loadFurnitureAssets(assetsRoot);
              if (assets && this.webview) {
                console.log('[Extension] Assets loaded, sending to webview');
                sendAssetsToWebview(this.webview, assets);
              }
            } catch (err) {
              console.error('[Extension] Error loading assets:', err);
            }

            if (this.webview) {
              console.log('[Extension] Sending saved layout');
              sendLayout(this.context, this.webview, this.defaultLayout);
              this.startLayoutWatcher();
            }
          })();
        } else {
          void (async () => {
            try {
              const extensionPath = this.extensionUri.fsPath;
              const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
              if (fs.existsSync(bundledAssetsDir)) {
                const distRoot = path.join(extensionPath, 'dist');
                this.defaultLayout = loadDefaultLayout(distRoot);

                const charSprites = await loadCharacterSprites(distRoot);
                if (charSprites && this.webview) {
                  sendCharacterSpritesToWebview(this.webview, charSprites);
                }

                const floorTiles = await loadFloorTiles(distRoot);
                if (floorTiles && this.webview) {
                  sendFloorTilesToWebview(this.webview, floorTiles);
                }

                const wallTiles = await loadWallTiles(distRoot);
                if (wallTiles && this.webview) {
                  sendWallTilesToWebview(this.webview, wallTiles);
                }
              }
            } catch {
              /* ignore */
            }

            if (this.webview) {
              sendLayout(this.context, this.webview, this.defaultLayout);
              this.startLayoutWatcher();
            }
          })();
        }

        sendExistingAgents(this.agents, this.context, this.webview);
      } else if (message.type === 'openSessionsFolder') {
        for (const providerId of [AGENT_PROVIDER_IDS.CLAUDE, AGENT_PROVIDER_IDS.CODEX]) {
          for (const projectDir of getProjectDirPaths(providerId)) {
            if (fs.existsSync(projectDir)) {
              void vscode.env.openExternal(vscode.Uri.file(projectDir));
              return;
            }
          }
        }
      } else if (message.type === 'exportLayout') {
        const layout = readLayoutFromFile();
        if (!layout) {
          vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
          return;
        }
        const uri = await vscode.window.showSaveDialog({
          filters: { 'JSON Files': ['json'] },
          defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pixel-agents-layout.json')),
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
          vscode.window.showInformationMessage('Pixel Agents: Layout exported successfully.');
        }
      } else if (message.type === 'importLayout') {
        const uris = await vscode.window.showOpenDialog({
          filters: { 'JSON Files': ['json'] },
          canSelectMany: false,
        });
        if (!uris || uris.length === 0) {
          return;
        }
        try {
          const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
          const imported = JSON.parse(raw) as Record<string, unknown>;
          if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
            vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
            return;
          }
          this.layoutWatcher?.markOwnWrite();
          writeLayoutToFile(imported);
          this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
          vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
        } catch {
          vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
        }
      }
    });

    vscode.window.onDidChangeActiveTerminal((terminal) => {
      this.activeAgentId.current = null;
      if (!terminal) {
        return;
      }
      for (const [id, agent] of this.agents) {
        if (agent.terminalRef === terminal) {
          this.activeAgentId.current = id;
          webviewView.webview.postMessage({ type: 'agentSelected', id });
          break;
        }
      }
    });

    vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, agent] of this.agents) {
        if (agent.terminalRef === closed) {
          if (this.activeAgentId.current === id) {
            this.activeAgentId.current = null;
          }
          removeAgent(
            id,
            this.agents,
            this.claimedJsonlFiles,
            this.claimedCodexSessions,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            this.jsonlPollTimers,
            this.persistAgents,
          );
          webviewView.webview.postMessage({ type: 'agentClosed', id });
        }
      }
    });
  }

  exportDefaultLayout(): void {
    const layout = readLayoutFromFile();
    if (!layout) {
      vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
      return;
    }
    const assetsDir = path.join(workspaceRoot, 'webview-ui', 'public', 'assets');

    let maxRevision = 0;
    if (fs.existsSync(assetsDir)) {
      for (const fileName of fs.readdirSync(assetsDir)) {
        const match = /^default-layout-(\d+)\.json$/.exec(fileName);
        if (match) {
          maxRevision = Math.max(maxRevision, parseInt(match[1], 10));
        }
      }
    }
    const nextRevision = maxRevision + 1;
    layout[LAYOUT_REVISION_KEY] = nextRevision;

    const targetPath = path.join(assetsDir, `default-layout-${nextRevision}.json`);
    fs.writeFileSync(targetPath, JSON.stringify(layout, null, 2), 'utf-8');
    vscode.window.showInformationMessage(
      `Pixel Agents: Default layout exported as revision ${nextRevision} to ${targetPath}`,
    );
  }

  private startLayoutWatcher(): void {
    if (this.layoutWatcher) {
      return;
    }
    this.layoutWatcher = watchLayoutFile((layout) => {
      console.log('[Pixel Agents] External layout change -> pushing to webview');
      this.webview?.postMessage({ type: 'layoutLoaded', layout });
    });
  }

  dispose() {
    this.layoutWatcher?.dispose();
    this.layoutWatcher = null;
    for (const id of [...this.agents.keys()]) {
      removeAgent(
        id,
        this.agents,
        this.claimedJsonlFiles,
        this.claimedCodexSessions,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        this.jsonlPollTimers,
        this.persistAgents,
      );
    }
    for (const timer of this.projectScanTimers.values()) {
      clearInterval(timer);
    }
    this.projectScanTimers.clear();
  }
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

  let html = fs.readFileSync(indexPath, 'utf-8');
  let assetsDirName = 'assets';
  const defaultAssetsDir = path.join(distPath.fsPath, assetsDirName);
  if (!fs.existsSync(defaultAssetsDir)) {
    try {
      const fallbackAssetsDir = fs
        .readdirSync(distPath.fsPath, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith('assets ('))
        ?.name;
      if (fallbackAssetsDir) {
        assetsDirName = fallbackAssetsDir;
        console.warn(`[Pixel Agents] Webview assets dir missing; using fallback "${assetsDirName}"`);
      }
    } catch {
      /* ignore */
    }
  }

  html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
    const normalizedFilePath = filePath.startsWith('assets/')
      ? `${assetsDirName}/${filePath.slice('assets/'.length)}`
      : filePath;
    const segments = normalizedFilePath.split(/[\\/]+/g).filter(Boolean);
    const fileUri = vscode.Uri.joinPath(distPath, ...segments);
    const webviewUri = webview.asWebviewUri(fileUri);
    return `${attr}="${webviewUri}"`;
  });

  return html;
}
