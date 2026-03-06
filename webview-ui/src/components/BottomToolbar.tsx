import { useEffect, useRef, useState } from 'react';

import type { AgentProviderId } from '../hooks/useEditorActions.js';
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { SettingsModal } from './SettingsModal.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onOpenAgent: (provider: AgentProviderId, folderPath?: string) => void;
  onToggleEditMode: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  workspaceFolders: WorkspaceFolder[];
}

const AGENT_PROVIDER_OPTIONS: Array<{ id: AgentProviderId; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  left: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  boxShadow: 'var(--pixel-shadow)',
};

const btnBase: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: '24px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
};

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
};

export function BottomToolbar({
  isEditMode,
  onOpenAgent,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  workspaceFolders,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [hoveredOption, setHoveredOption] = useState<string | null>(null);
  const launcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLauncherOpen) {
      return;
    }
    const handleClick = (e: MouseEvent) => {
      if (launcherRef.current && !launcherRef.current.contains(e.target as Node)) {
        setIsLauncherOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isLauncherOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;
  const launchOptions = hasMultipleFolders
    ? workspaceFolders.flatMap((folder) =>
        AGENT_PROVIDER_OPTIONS.map((provider) => ({
          key: `${provider.id}:${folder.path}`,
          label: `${provider.label}: ${folder.name}`,
          provider: provider.id,
          folderPath: folder.path,
        })),
      )
    : AGENT_PROVIDER_OPTIONS.map((provider) => ({
        key: provider.id,
        label: provider.label,
        provider: provider.id,
        folderPath: undefined,
      }));

  const handleAgentClick = () => {
    setIsLauncherOpen((value) => !value);
  };

  const handleLaunchSelect = (provider: AgentProviderId, folderPath?: string) => {
    setIsLauncherOpen(false);
    onOpenAgent(provider, folderPath);
  };

  return (
    <div style={panelStyle}>
      <div ref={launcherRef} style={{ position: 'relative' }}>
        <button
          onClick={handleAgentClick}
          onMouseEnter={() => setHovered('agent')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            padding: '5px 12px',
            background:
              hovered === 'agent' || isLauncherOpen
                ? 'var(--pixel-agent-hover-bg)'
                : 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            color: 'var(--pixel-agent-text)',
          }}
        >
          + Agent
        </button>
        {isLauncherOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow)',
              minWidth: 180,
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            {launchOptions.map((option) => (
              <button
                key={option.key}
                onClick={() => handleLaunchSelect(option.provider, option.folderPath)}
                onMouseEnter={() => setHoveredOption(option.key)}
                onMouseLeave={() => setHoveredOption(null)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 10px',
                  fontSize: '22px',
                  color: 'var(--pixel-text)',
                  background:
                    hoveredOption === option.key ? 'var(--pixel-btn-hover-bg)' : 'transparent',
                  border: 'none',
                  borderRadius: 0,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={onToggleEditMode}
        onMouseEnter={() => setHovered('edit')}
        onMouseLeave={() => setHovered(null)}
        style={
          isEditMode
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Edit office layout"
      >
        Layout
      </button>
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setIsSettingsOpen((value) => !value)}
          onMouseEnter={() => setHovered('settings')}
          onMouseLeave={() => setHovered(null)}
          style={
            isSettingsOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background:
                    hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Settings"
        >
          Settings
        </button>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
          alwaysShowOverlay={alwaysShowOverlay}
          onToggleAlwaysShowOverlay={onToggleAlwaysShowOverlay}
        />
      </div>
    </div>
  );
}
