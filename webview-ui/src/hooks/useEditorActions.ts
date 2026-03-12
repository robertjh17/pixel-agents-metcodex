import { useCallback, useRef, useState } from 'react';

import { LAYOUT_SAVE_DEBOUNCE_MS, ZOOM_MAX, ZOOM_MIN } from '../constants.js';
import type { ExpandDirection } from '../office/editor/editorActions.js';
import {
  canPlaceFurniture,
  expandLayout,
  getWallPlacementRow,
  moveFurniture,
  paintTile,
  placeFurniture,
  removeFurniture,
  rotateFurniture,
  toggleFurnitureState,
} from '../office/editor/editorActions.js';
import type { EditorState } from '../office/editor/editorState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { getCatalogEntry, getRotatedType, getToggledType } from '../office/layout/furnitureCatalog.js';
import { defaultZoom } from '../office/toolUtils.js';
import type {
  EditTool as EditToolType,
  FloorColor,
  OfficeLayout,
  PlacedFurniture,
  TileType as TileTypeVal,
} from '../office/types.js';
import { EditTool, TileType } from '../office/types.js';
import { vscode } from '../vscodeApi.js';

export type AgentProviderId = 'claude' | 'codex' | 'copilot';

export interface EditorActions {
  isEditMode: boolean;
  editorTick: number;
  isDirty: boolean;
  zoom: number;
  panRef: React.MutableRefObject<{ x: number; y: number }>;
  saveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setLastSavedLayout: (layout: OfficeLayout) => void;
  handleOpenAgent: (provider: AgentProviderId, folderPath?: string) => void;
  handleToggleEditMode: () => void;
  handleToolChange: (tool: EditToolType) => void;
  handleTileTypeChange: (type: TileTypeVal) => void;
  handleFloorColorChange: (color: FloorColor) => void;
  handleWallColorChange: (color: FloorColor) => void;
  handleWallSetChange: (setIndex: number) => void;
  handleSelectedFurnitureColorChange: (color: FloorColor | null) => void;
  handleFurnitureTypeChange: (type: string) => void;
  handleDeleteSelected: () => void;
  handleRotateSelected: () => void;
  handleToggleState: () => void;
  handleUndo: () => void;
  handleRedo: () => void;
  handleReset: () => void;
  handleSave: () => void;
  handleZoomChange: (zoom: number) => void;
  handleEditorTileAction: (col: number, row: number) => void;
  handleEditorEraseAction: (col: number, row: number) => void;
  handleEditorSelectionChange: () => void;
  handleDragMove: (uid: string, newCol: number, newRow: number) => void;
}

export function useEditorActions(
  getOfficeState: () => OfficeState,
  editorState: EditorState,
): EditorActions {
  const [isEditMode, setIsEditMode] = useState(false);
  const [editorTick, setEditorTick] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const [zoom, setZoom] = useState(defaultZoom);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const lastSavedLayoutRef = useRef<OfficeLayout | null>(null);
  const wallColorEditActiveRef = useRef(false);
  const colorEditUidRef = useRef<string | null>(null);

  const setLastSavedLayout = useCallback((layout: OfficeLayout) => {
    lastSavedLayoutRef.current = structuredClone(layout);
  }, []);

  const saveLayout = useCallback((layout: OfficeLayout) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      vscode.postMessage({ type: 'saveLayout', layout });
    }, LAYOUT_SAVE_DEBOUNCE_MS);
  }, []);

  const applyEdit = useCallback(
    (newLayout: OfficeLayout) => {
      const officeState = getOfficeState();
      editorState.pushUndo(officeState.getLayout());
      editorState.clearRedo();
      editorState.isDirty = true;
      setIsDirty(true);
      officeState.rebuildFromLayout(newLayout);
      saveLayout(newLayout);
      setEditorTick((tick) => tick + 1);
    },
    [editorState, getOfficeState, saveLayout],
  );

  const handleOpenAgent = useCallback((provider: AgentProviderId, folderPath?: string) => {
    vscode.postMessage({ type: 'openAgent', provider, folderPath });
  }, []);

  const handleToggleEditMode = useCallback(() => {
    setIsEditMode((prev) => {
      const next = !prev;
      editorState.isEditMode = next;
      if (next) {
        const officeState = getOfficeState();
        const layout = officeState.getLayout();
        if (layout.tileColors) {
          for (let i = 0; i < layout.tiles.length; i++) {
            if (layout.tiles[i] === TileType.WALL && layout.tileColors[i]) {
              editorState.wallColor = { ...layout.tileColors[i]! };
              break;
            }
          }
        }
      } else {
        editorState.clearSelection();
        editorState.clearGhost();
        editorState.clearDrag();
        wallColorEditActiveRef.current = false;
      }
      return next;
    });
  }, [editorState, getOfficeState]);

  const handleToolChange = useCallback(
    (tool: EditToolType) => {
      editorState.activeTool = editorState.activeTool === tool ? EditTool.SELECT : tool;
      editorState.clearSelection();
      editorState.clearGhost();
      editorState.clearDrag();
      colorEditUidRef.current = null;
      wallColorEditActiveRef.current = false;
      setEditorTick((tick) => tick + 1);
    },
    [editorState],
  );

  const handleTileTypeChange = useCallback(
    (type: TileTypeVal) => {
      editorState.selectedTileType = type;
      setEditorTick((tick) => tick + 1);
    },
    [editorState],
  );

  const handleFloorColorChange = useCallback(
    (color: FloorColor) => {
      editorState.floorColor = color;
      setEditorTick((tick) => tick + 1);
    },
    [editorState],
  );

  const handleWallColorChange = useCallback(
    (color: FloorColor) => {
      editorState.wallColor = color;

      const officeState = getOfficeState();
      const layout = officeState.getLayout();
      const existingColors = layout.tileColors || new Array(layout.tiles.length).fill(null);
      const newColors = [...existingColors];
      let changed = false;

      for (let i = 0; i < layout.tiles.length; i++) {
        if (layout.tiles[i] === TileType.WALL) {
          newColors[i] = { ...color };
          changed = true;
        }
      }

      if (changed) {
        if (!wallColorEditActiveRef.current) {
          editorState.pushUndo(layout);
          editorState.clearRedo();
          wallColorEditActiveRef.current = true;
        }
        const newLayout = { ...layout, tileColors: newColors };
        editorState.isDirty = true;
        setIsDirty(true);
        officeState.rebuildFromLayout(newLayout);
        saveLayout(newLayout);
      }

      setEditorTick((tick) => tick + 1);
    },
    [editorState, getOfficeState, saveLayout],
  );

  const handleWallSetChange = useCallback(
    (setIndex: number) => {
      editorState.selectedWallSet = setIndex;
      setEditorTick((tick) => tick + 1);
    },
    [editorState],
  );

  const handleSelectedFurnitureColorChange = useCallback(
    (color: FloorColor | null) => {
      const uid = editorState.selectedFurnitureUid;
      if (!uid) {
        return;
      }
      const officeState = getOfficeState();
      const layout = officeState.getLayout();

      if (colorEditUidRef.current !== uid) {
        editorState.pushUndo(layout);
        editorState.clearRedo();
        colorEditUidRef.current = uid;
      }

      const newFurniture = layout.furniture.map((item) =>
        item.uid === uid ? { ...item, color: color ?? undefined } : item,
      );
      const newLayout = { ...layout, furniture: newFurniture };

      editorState.isDirty = true;
      setIsDirty(true);
      officeState.rebuildFromLayout(newLayout);
      saveLayout(newLayout);
      setEditorTick((tick) => tick + 1);
    },
    [editorState, getOfficeState, saveLayout],
  );

  const handleFurnitureTypeChange = useCallback(
    (type: string) => {
      if (editorState.selectedFurnitureType === type) {
        editorState.selectedFurnitureType = '';
        editorState.clearGhost();
      } else {
        editorState.selectedFurnitureType = type;
      }
      setEditorTick((tick) => tick + 1);
    },
    [editorState],
  );

  const handleDeleteSelected = useCallback(() => {
    const uid = editorState.selectedFurnitureUid;
    if (!uid) {
      return;
    }
    const officeState = getOfficeState();
    const newLayout = removeFurniture(officeState.getLayout(), uid);
    if (newLayout !== officeState.getLayout()) {
      applyEdit(newLayout);
      editorState.clearSelection();
      colorEditUidRef.current = null;
    }
  }, [applyEdit, editorState, getOfficeState]);

  const handleRotateSelected = useCallback(() => {
    if (editorState.activeTool === EditTool.FURNITURE_PLACE) {
      const rotated = getRotatedType(editorState.selectedFurnitureType, 'cw');
      if (rotated) {
        editorState.selectedFurnitureType = rotated;
        setEditorTick((tick) => tick + 1);
      }
      return;
    }
    const uid = editorState.selectedFurnitureUid;
    if (!uid) {
      return;
    }
    const officeState = getOfficeState();
    const newLayout = rotateFurniture(officeState.getLayout(), uid, 'cw');
    if (newLayout !== officeState.getLayout()) {
      applyEdit(newLayout);
    }
  }, [applyEdit, editorState, getOfficeState]);

  const handleToggleState = useCallback(() => {
    if (editorState.activeTool === EditTool.FURNITURE_PLACE) {
      const toggled = getToggledType(editorState.selectedFurnitureType);
      if (toggled) {
        editorState.selectedFurnitureType = toggled;
        setEditorTick((tick) => tick + 1);
      }
      return;
    }
    const uid = editorState.selectedFurnitureUid;
    if (!uid) {
      return;
    }
    const officeState = getOfficeState();
    const newLayout = toggleFurnitureState(officeState.getLayout(), uid);
    if (newLayout !== officeState.getLayout()) {
      applyEdit(newLayout);
    }
  }, [applyEdit, editorState, getOfficeState]);

  const handleUndo = useCallback(() => {
    const prev = editorState.popUndo();
    if (!prev) {
      return;
    }
    const officeState = getOfficeState();
    editorState.pushRedo(officeState.getLayout());
    officeState.rebuildFromLayout(prev);
    saveLayout(prev);
    editorState.isDirty = true;
    setIsDirty(true);
    setEditorTick((tick) => tick + 1);
  }, [editorState, getOfficeState, saveLayout]);

  const handleRedo = useCallback(() => {
    const next = editorState.popRedo();
    if (!next) {
      return;
    }
    const officeState = getOfficeState();
    editorState.pushUndo(officeState.getLayout());
    officeState.rebuildFromLayout(next);
    saveLayout(next);
    editorState.isDirty = true;
    setIsDirty(true);
    setEditorTick((tick) => tick + 1);
  }, [editorState, getOfficeState, saveLayout]);

  const handleReset = useCallback(() => {
    if (!lastSavedLayoutRef.current) {
      return;
    }
    const saved = structuredClone(lastSavedLayoutRef.current);
    applyEdit(saved);
    editorState.reset();
    setIsDirty(false);
  }, [applyEdit, editorState]);

  const handleSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const officeState = getOfficeState();
    const layout = officeState.getLayout();
    lastSavedLayoutRef.current = structuredClone(layout);
    vscode.postMessage({ type: 'saveLayout', layout });
    editorState.isDirty = false;
    setIsDirty(false);
  }, [editorState, getOfficeState]);

  const handleEditorSelectionChange = useCallback(() => {
    colorEditUidRef.current = null;
    setEditorTick((tick) => tick + 1);
  }, []);

  const handleZoomChange = useCallback((newZoom: number) => {
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom)));
  }, []);

  const handleDragMove = useCallback(
    (uid: string, newCol: number, newRow: number) => {
      const officeState = getOfficeState();
      const layout = officeState.getLayout();
      const newLayout = moveFurniture(layout, uid, newCol, newRow);
      if (newLayout !== layout) {
        applyEdit(newLayout);
      }
    },
    [applyEdit, getOfficeState],
  );

  const maybeExpand = useCallback(
    (
      layout: OfficeLayout,
      col: number,
      row: number,
    ): { layout: OfficeLayout; col: number; row: number; shift: { col: number; row: number } } | null => {
      if (col >= 0 && col < layout.cols && row >= 0 && row < layout.rows) {
        return null;
      }

      const directions: ExpandDirection[] = [];
      if (col < 0) {
        directions.push('left');
      }
      if (col >= layout.cols) {
        directions.push('right');
      }
      if (row < 0) {
        directions.push('up');
      }
      if (row >= layout.rows) {
        directions.push('down');
      }

      let current = layout;
      let totalShiftCol = 0;
      let totalShiftRow = 0;
      for (const dir of directions) {
        const result = expandLayout(current, dir);
        if (!result) {
          return null;
        }
        current = result.layout;
        totalShiftCol += result.shift.col;
        totalShiftRow += result.shift.row;
      }

      return {
        layout: current,
        col: col + totalShiftCol,
        row: row + totalShiftRow,
        shift: { col: totalShiftCol, row: totalShiftRow },
      };
    },
    [],
  );

  const handleEditorTileAction = useCallback(
    (col: number, row: number) => {
      const officeState = getOfficeState();
      let layout = officeState.getLayout();
      let effectiveCol = col;
      let effectiveRow = row;

      if (editorState.activeTool === EditTool.TILE_PAINT || editorState.activeTool === EditTool.WALL_PAINT) {
        const expansion = maybeExpand(layout, col, row);
        if (expansion) {
          layout = expansion.layout;
          effectiveCol = expansion.col;
          effectiveRow = expansion.row;
          officeState.rebuildFromLayout(layout, expansion.shift);
        }
      }

      if (editorState.activeTool === EditTool.TILE_PAINT) {
        const newLayout = paintTile(
          layout,
          effectiveCol,
          effectiveRow,
          editorState.selectedTileType,
          editorState.floorColor,
        );
        if (newLayout !== layout) {
          applyEdit(newLayout);
        }
      } else if (editorState.activeTool === EditTool.WALL_PAINT) {
        const idx = effectiveRow * layout.cols + effectiveCol;
        const isWall = layout.tiles[idx] === TileType.WALL;

        if (editorState.wallDragAdding === null) {
          editorState.wallDragAdding = !isWall;
        }

        if (editorState.wallDragAdding) {
          const newLayout = paintTile(layout, effectiveCol, effectiveRow, TileType.WALL, editorState.wallColor);
          if (newLayout !== layout) {
            applyEdit(newLayout);
          }
        } else if (isWall) {
          const newLayout = paintTile(
            layout,
            effectiveCol,
            effectiveRow,
            editorState.selectedTileType,
            editorState.floorColor,
          );
          if (newLayout !== layout) {
            applyEdit(newLayout);
          }
        }
      } else if (editorState.activeTool === EditTool.ERASE) {
        if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) {
          return;
        }
        const idx = row * layout.cols + col;
        if (layout.tiles[idx] === TileType.VOID) {
          return;
        }
        const newLayout = paintTile(layout, col, row, TileType.VOID);
        if (newLayout !== layout) {
          applyEdit(newLayout);
        }
      } else if (editorState.activeTool === EditTool.FURNITURE_PLACE) {
        const type = editorState.selectedFurnitureType;
        if (type === '') {
          const hit = layout.furniture.find((item) => {
            const entry = getCatalogEntry(item.type);
            if (!entry) {
              return false;
            }
            return (
              col >= item.col &&
              col < item.col + entry.footprintW &&
              row >= item.row &&
              row < item.row + entry.footprintH
            );
          });
          editorState.selectedFurnitureUid = hit ? hit.uid : null;
          setEditorTick((tick) => tick + 1);
        } else {
          const placementRow = getWallPlacementRow(type, row);
          if (!canPlaceFurniture(layout, type, col, placementRow)) {
            return;
          }
          const uid = `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const placed: PlacedFurniture = { uid, type, col, row: placementRow };
          if (editorState.pickedFurnitureColor) {
            placed.color = { ...editorState.pickedFurnitureColor };
          }
          const newLayout = placeFurniture(layout, placed);
          if (newLayout !== layout) {
            applyEdit(newLayout);
          }
        }
      } else if (editorState.activeTool === EditTool.FURNITURE_PICK) {
        const hit = layout.furniture.find((item) => {
          const entry = getCatalogEntry(item.type);
          if (!entry) {
            return false;
          }
          return (
            col >= item.col &&
            col < item.col + entry.footprintW &&
            row >= item.row &&
            row < item.row + entry.footprintH
          );
        });
        if (hit) {
          editorState.selectedFurnitureType = hit.type;
          editorState.pickedFurnitureColor = hit.color ? { ...hit.color } : null;
          editorState.activeTool = EditTool.FURNITURE_PLACE;
        }
        setEditorTick((tick) => tick + 1);
      } else if (editorState.activeTool === EditTool.EYEDROPPER) {
        const idx = row * layout.cols + col;
        const tile = layout.tiles[idx];
        if (tile !== undefined && tile !== TileType.WALL && tile !== TileType.VOID) {
          editorState.selectedTileType = tile;
          const color = layout.tileColors?.[idx];
          if (color) {
            editorState.floorColor = { ...color };
          }
          editorState.activeTool = EditTool.TILE_PAINT;
        } else if (tile === TileType.WALL) {
          const color = layout.tileColors?.[idx];
          if (color) {
            editorState.wallColor = { ...color };
          }
          editorState.activeTool = EditTool.WALL_PAINT;
        }
        setEditorTick((tick) => tick + 1);
      } else if (editorState.activeTool === EditTool.SELECT) {
        const hit = layout.furniture.find((item) => {
          const entry = getCatalogEntry(item.type);
          if (!entry) {
            return false;
          }
          return (
            col >= item.col &&
            col < item.col + entry.footprintW &&
            row >= item.row &&
            row < item.row + entry.footprintH
          );
        });
        editorState.selectedFurnitureUid = hit ? hit.uid : null;
        setEditorTick((tick) => tick + 1);
      }
    },
    [applyEdit, editorState, getOfficeState, maybeExpand],
  );

  const handleEditorEraseAction = useCallback(
    (col: number, row: number) => {
      const officeState = getOfficeState();
      const layout = officeState.getLayout();
      if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) {
        return;
      }
      const idx = row * layout.cols + col;
      if (layout.tiles[idx] === TileType.VOID) {
        return;
      }
      const newLayout = paintTile(layout, col, row, TileType.VOID);
      if (newLayout !== layout) {
        applyEdit(newLayout);
      }
    },
    [applyEdit, getOfficeState],
  );

  return {
    isEditMode,
    editorTick,
    isDirty,
    zoom,
    panRef,
    saveTimerRef,
    setLastSavedLayout,
    handleOpenAgent,
    handleToggleEditMode,
    handleToolChange,
    handleTileTypeChange,
    handleFloorColorChange,
    handleWallColorChange,
    handleWallSetChange,
    handleSelectedFurnitureColorChange,
    handleFurnitureTypeChange,
    handleDeleteSelected,
    handleRotateSelected,
    handleToggleState,
    handleUndo,
    handleRedo,
    handleReset,
    handleSave,
    handleZoomChange,
    handleEditorTileAction,
    handleEditorEraseAction,
    handleEditorSelectionChange,
    handleDragMove,
  };
}
