import type { BuildOptions, Scene } from '../../core/src/types';

export interface Settings {
  // png: every layer is a Figma rendered PNG. hybrid: vector layers that map exactly become Fusion
  // nodes, the rest stay PNG. Whether icons are split is the separate flattenIcons switch.
  importMode: 'png' | 'hybrid';
  // all: every layer becomes its own element. top: each direct child of the frame is one element.
  // Either way a single group can be overridden from the preview tree (stored on the Figma layer).
  splitMode: 'all' | 'top';
  shapeStyle: 'masks' | 'shapes';
  multiplier: 1 | 2 | 3 | 4;
  // Small elements get a higher multiplier so they stay sharp (capped at 4).
  boostSmall: boolean;
  textMode: 'textplus' | 'png';
  transformNodes: boolean;
  flattenIcons: boolean;
  compSize: 'frame' | '1920x1080' | '3840x2160' | '1080x1920' | '1080x1080';
  folder: string;
  delivery: 'clipboard' | 'resolve';
  drawerOpen: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  importMode: 'png',
  splitMode: 'all',
  shapeStyle: 'masks',
  multiplier: 2,
  boostSmall: true,
  textMode: 'textplus',
  transformNodes: true,
  flattenIcons: true,
  compSize: 'frame',
  folder: '',
  delivery: 'clipboard',
  drawerOpen: false,
};

export interface Asset {
  // Placeholder stored in ImageLayer.file until the companion returns the real path.
  key: string;
  fileName: string;
  bytes: Uint8Array;
}

// One row of the node tree preview, in the order Fusion builds it (bottom layer first).
// A group's children come before the group row, one level deeper.
export interface PreviewRow {
  name: string;
  kind: 'image' | 'text' | 'group' | 'shape';
  depth: number;
  // Set on groups and on groups sent as one element: the Figma node a click toggles.
  nodeId?: string;
  // A container sent as one PNG.
  merged?: boolean;
  // False when the name (*) or the content (a mask, effects) forces it, so a click cannot change it.
  canToggle?: boolean;
}

export interface SelectionSummary {
  label: string;
  // Frame or parent frame name, empty when nothing usable is selected.
  title: string;
  frame: { width: number; height: number };
  rows: PreviewRow[];
  moreRows: number;
  images: number;
  shapes: number;
  texts: number;
  groups: number;
  ok: boolean;
}

export type ToUi =
  | { type: 'init'; settings: Settings; summary: SelectionSummary }
  | { type: 'selection'; summary: SelectionSummary }
  | { type: 'progress'; done: number; total: number; name: string }
  | { type: 'export-done'; scene: Scene; options: BuildOptions; assets: Asset[]; fileName: string; notes: string[] }
  | { type: 'error'; message: string };

export type ToCode =
  | { type: 'send'; settings: Settings }
  | { type: 'save-settings'; settings: Settings }
  | { type: 'notify'; message: string; error?: boolean }
  | { type: 'resize'; height: number }
  | { type: 'set-split'; nodeId: string; value: 'merge' | 'split' };
