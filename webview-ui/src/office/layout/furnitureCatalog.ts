import { FurnitureType } from '../types.js';
import type { FurnitureCatalogEntry, SpriteData } from '../types.js';
import {
  BOOKSHELF_SPRITE,
  CHAIR_SPRITE,
  COOLER_SPRITE,
  DESK_SQUARE_SPRITE,
  LAMP_SPRITE,
  PC_SPRITE,
  PLANT_SPRITE,
  SEAT_SPRITE,
  WHITEBOARD_SPRITE,
} from '../sprites/spriteData.js';

export interface LoadedAssetData {
  catalog: Array<{
    id: string;
    label: string;
    category: string;
    width: number;
    height: number;
    footprintW: number;
    footprintH: number;
    isDesk: boolean;
    groupId?: string;
    orientation?: string;
    state?: string;
    canPlaceOnSurfaces?: boolean;
    backgroundTiles?: number;
    canPlaceOnWalls?: boolean;
    mirrorSide?: boolean;
    rotationScheme?: string;
    animationGroup?: string;
    frame?: number;
  }>;
  sprites: Record<string, SpriteData>;
}

export type FurnitureCategory =
  | 'desks'
  | 'chairs'
  | 'storage'
  | 'decor'
  | 'electronics'
  | 'wall'
  | 'misc';

export interface CatalogEntryWithCategory extends FurnitureCatalogEntry {
  category: FurnitureCategory;
}

export const FURNITURE_CATALOG: CatalogEntryWithCategory[] = [
  { type: FurnitureType.DESK, label: 'Desk', footprintW: 2, footprintH: 2, sprite: DESK_SQUARE_SPRITE, isDesk: true, category: 'desks' },
  { type: FurnitureType.BOOKSHELF, label: 'Bookshelf', footprintW: 1, footprintH: 2, sprite: BOOKSHELF_SPRITE, isDesk: false, category: 'storage' },
  { type: FurnitureType.PLANT, label: 'Plant', footprintW: 1, footprintH: 1, sprite: PLANT_SPRITE, isDesk: false, category: 'decor' },
  { type: FurnitureType.COOLER, label: 'Cooler', footprintW: 1, footprintH: 1, sprite: COOLER_SPRITE, isDesk: false, category: 'misc' },
  { type: FurnitureType.WHITEBOARD, label: 'Whiteboard', footprintW: 2, footprintH: 1, sprite: WHITEBOARD_SPRITE, isDesk: false, category: 'decor' },
  { type: FurnitureType.CHAIR, label: 'Chair', footprintW: 1, footprintH: 1, sprite: CHAIR_SPRITE, isDesk: false, category: 'chairs' },
  { type: FurnitureType.SEAT, label: 'Seat', footprintW: 1, footprintH: 1, sprite: SEAT_SPRITE, isDesk: false, category: 'chairs' },
  { type: FurnitureType.PC, label: 'PC', footprintW: 1, footprintH: 1, sprite: PC_SPRITE, isDesk: false, category: 'electronics' },
  { type: FurnitureType.LAMP, label: 'Lamp', footprintW: 1, footprintH: 1, sprite: LAMP_SPRITE, isDesk: false, category: 'decor' },
];

interface RotationGroup {
  orientations: string[];
  members: Record<string, string>;
}

const rotationGroups = new Map<string, RotationGroup>();
const stateGroups = new Map<string, string>();
const offToOn = new Map<string, string>();
const onToOff = new Map<string, string>();
const animationGroups = new Map<string, string[]>();

let internalCatalog: CatalogEntryWithCategory[] | null = null;
let dynamicCatalog: CatalogEntryWithCategory[] | null = null;
let dynamicCategories: FurnitureCategory[] | null = null;

export function buildDynamicCatalog(assets: LoadedAssetData): boolean {
  if (!assets?.catalog || !assets?.sprites) return false;

  const allEntries = assets.catalog
    .map((asset) => {
      const sprite = assets.sprites[asset.id];
      if (!sprite) {
        console.warn(`No sprite data for asset ${asset.id}`);
        return null;
      }
      return {
        type: asset.id,
        label: asset.label,
        footprintW: asset.footprintW,
        footprintH: asset.footprintH,
        sprite,
        isDesk: asset.isDesk,
        category: asset.category as FurnitureCategory,
        ...(asset.orientation ? { orientation: asset.orientation } : {}),
        ...(asset.canPlaceOnSurfaces ? { canPlaceOnSurfaces: true } : {}),
        ...(asset.backgroundTiles ? { backgroundTiles: asset.backgroundTiles } : {}),
        ...(asset.canPlaceOnWalls ? { canPlaceOnWalls: true } : {}),
        ...(asset.mirrorSide ? { mirrorSide: true } : {}),
      };
    })
    .filter((entry): entry is CatalogEntryWithCategory => entry !== null);

  for (const asset of assets.catalog) {
    if (asset.mirrorSide && asset.orientation === 'side') {
      const sideEntry = allEntries.find((entry) => entry.type === asset.id);
      if (sideEntry) {
        allEntries.push({
          ...sideEntry,
          type: `${asset.id}:left`,
          orientation: 'left',
          mirrorSide: true,
        });
      }
    }
  }

  if (allEntries.length === 0) return false;

  rotationGroups.clear();
  stateGroups.clear();
  offToOn.clear();
  onToOff.clear();
  animationGroups.clear();

  const groupMap = new Map<string, Map<string, string>>();
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.orientation) {
      if (asset.state && asset.state !== 'off') continue;
      let orientMap = groupMap.get(asset.groupId);
      if (!orientMap) {
        orientMap = new Map();
        groupMap.set(asset.groupId, orientMap);
      }

      if (asset.orientation === 'side') {
        orientMap.set('right', asset.id);
        if (asset.mirrorSide) {
          orientMap.set('left', `${asset.id}:left`);
        }
      } else {
        orientMap.set(asset.orientation, asset.id);
      }
    }
  }

  const rotationSchemes = new Map<string, string>();
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.rotationScheme) {
      rotationSchemes.set(asset.groupId, asset.rotationScheme);
    }
  }

  const nonFrontIds = new Set<string>();
  const orientationOrder = ['front', 'right', 'back', 'left'];
  for (const [groupId, orientMap] of groupMap) {
    if (orientMap.size < 2) continue;
    const scheme = rotationSchemes.get(groupId);
    let allowedOrients = orientationOrder;
    if (scheme === '2-way') {
      allowedOrients = ['front', 'right'];
    }

    const orderedOrients = allowedOrients.filter((orientation) => orientMap.has(orientation));
    if (orderedOrients.length < 2) continue;
    const members: Record<string, string> = {};
    for (const orientation of orderedOrients) {
      members[orientation] = orientMap.get(orientation)!;
    }
    const rotationGroup: RotationGroup = { orientations: orderedOrients, members };
    const registeredIds = new Set<string>();
    for (const id of Object.values(members)) {
      if (!registeredIds.has(id)) {
        rotationGroups.set(id, rotationGroup);
        registeredIds.add(id);
      }
    }
    for (const [orientation, id] of Object.entries(members)) {
      if (orientation !== 'front') nonFrontIds.add(id);
    }
  }

  const stateMap = new Map<string, Map<string, string>>();
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.state) {
      const key = `${asset.groupId}|${asset.orientation || ''}`;
      let stateEntry = stateMap.get(key);
      if (!stateEntry) {
        stateEntry = new Map();
        stateMap.set(key, stateEntry);
      }
      if (asset.animationGroup && asset.frame !== undefined && asset.frame > 0) continue;
      stateEntry.set(asset.state, asset.id);
    }
  }
  for (const stateEntry of stateMap.values()) {
    const onId = stateEntry.get('on');
    const offId = stateEntry.get('off');
    if (onId && offId) {
      stateGroups.set(onId, offId);
      stateGroups.set(offId, onId);
      offToOn.set(offId, onId);
      onToOff.set(onId, offId);
    }
  }

  for (const asset of assets.catalog) {
    if (asset.groupId && asset.orientation && asset.state === 'on') {
      if (asset.animationGroup && asset.frame !== undefined && asset.frame > 0) continue;

      const offCounterpart = stateGroups.get(asset.id);
      if (!offCounterpart) continue;
      const offGroup = rotationGroups.get(offCounterpart);
      if (!offGroup) continue;

      const onMembers: Record<string, string> = {};
      for (const orientation of offGroup.orientations) {
        const offId = offGroup.members[orientation];
        const onId = stateGroups.get(offId);
        onMembers[orientation] = onId ?? offId;
      }
      const onGroup: RotationGroup = {
        orientations: offGroup.orientations,
        members: onMembers,
      };
      for (const id of Object.values(onMembers)) {
        if (!rotationGroups.has(id)) {
          rotationGroups.set(id, onGroup);
        }
      }
    }
  }

  const animationCollector = new Map<string, Array<{ id: string; frame: number }>>();
  for (const asset of assets.catalog) {
    if (asset.animationGroup && asset.frame !== undefined) {
      let frames = animationCollector.get(asset.animationGroup);
      if (!frames) {
        frames = [];
        animationCollector.set(asset.animationGroup, frames);
      }
      frames.push({ id: asset.id, frame: asset.frame });
    }
  }
  for (const [groupId, frames] of animationCollector) {
    frames.sort((left, right) => left.frame - right.frame);
    animationGroups.set(
      groupId,
      frames.map((frame) => frame.id),
    );
  }

  const onStateIds = new Set<string>();
  for (const asset of assets.catalog) {
    if (asset.state === 'on') onStateIds.add(asset.id);
  }

  internalCatalog = allEntries;

  const visibleEntries = allEntries.filter((entry) => !nonFrontIds.has(entry.type) && !onStateIds.has(entry.type));
  for (const entry of visibleEntries) {
    if (rotationGroups.has(entry.type) || stateGroups.has(entry.type)) {
      entry.label = entry.label.replace(/ - Front - Off$/, '').replace(/ - Front$/, '').replace(/ - Off$/, '');
    }
  }

  dynamicCatalog = visibleEntries;
  dynamicCategories = Array.from(new Set(visibleEntries.map((entry) => entry.category)))
    .filter((category): category is FurnitureCategory => !!category)
    .sort();

  const rotationGroupCount = new Set(Array.from(rotationGroups.values())).size;
  const animationGroupCount = animationGroups.size;
  console.log(
    `Built dynamic catalog with ${allEntries.length} assets (${visibleEntries.length} visible, ${rotationGroupCount} rotation groups, ${stateGroups.size / 2} state pairs, ${animationGroupCount} animation groups)`,
  );
  return true;
}

export function getCatalogEntry(type: string): CatalogEntryWithCategory | undefined {
  if (internalCatalog) {
    return internalCatalog.find((entry) => entry.type === type);
  }
  return (dynamicCatalog ?? FURNITURE_CATALOG).find((entry) => entry.type === type);
}

export function getCatalogByCategory(category: FurnitureCategory): CatalogEntryWithCategory[] {
  const catalog = dynamicCatalog ?? FURNITURE_CATALOG;
  return catalog.filter((entry) => entry.category === category);
}

export function getActiveCatalog(): CatalogEntryWithCategory[] {
  return dynamicCatalog ?? FURNITURE_CATALOG;
}

export function getActiveCategories(): Array<{ id: FurnitureCategory; label: string }> {
  const categories = dynamicCategories ?? Array.from(new Set(FURNITURE_CATALOG.map((entry) => entry.category)));
  return FURNITURE_CATEGORIES.filter((category) => categories.includes(category.id));
}

export const FURNITURE_CATEGORIES: Array<{ id: FurnitureCategory; label: string }> = [
  { id: 'desks', label: 'Desks' },
  { id: 'chairs', label: 'Chairs' },
  { id: 'storage', label: 'Storage' },
  { id: 'electronics', label: 'Tech' },
  { id: 'decor', label: 'Decor' },
  { id: 'wall', label: 'Wall' },
  { id: 'misc', label: 'Misc' },
];

export function getRotatedType(currentType: string, direction: 'cw' | 'ccw'): string | null {
  const group = rotationGroups.get(currentType);
  if (!group) return null;
  const order = group.orientations.map((orientation) => group.members[orientation]);
  const index = order.indexOf(currentType);
  if (index === -1) return null;
  const step = direction === 'cw' ? 1 : -1;
  const nextIndex = (index + step + order.length) % order.length;
  return order[nextIndex];
}

export function getToggledType(currentType: string): string | null {
  return stateGroups.get(currentType) ?? null;
}

export function getOnStateType(currentType: string): string {
  return offToOn.get(currentType) ?? currentType;
}

export function getOffStateType(currentType: string): string {
  return onToOff.get(currentType) ?? currentType;
}

export function isRotatable(type: string): boolean {
  return rotationGroups.has(type);
}

export function getAnimationFrames(type: string): string[] | null {
  for (const [, frames] of animationGroups) {
    if (frames.includes(type)) return frames;
  }
  return null;
}

export function getOrientationInGroup(type: string): string | undefined {
  const group = rotationGroups.get(type);
  if (!group) return undefined;
  for (const [orientation, id] of Object.entries(group.members)) {
    if (id === type) return orientation;
  }
  return undefined;
}
