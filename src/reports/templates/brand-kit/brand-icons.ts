import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Content } from 'pdfmake/interfaces';

/**
 * Brand icons (FR-T1) — Lucide stroke icons bundled as SVGs (the same set
 * the FE renders via lucide-react-native, extracted from its package;
 * Lucide is ISC-licensed). Read once at module load; `iconNode` recolors
 * the stroke to a brand token and returns a pdfmake svg node — vector
 * output, crisp at any print size (no raster step).
 */

const ICONS_DIR = join(__dirname, 'assets', 'icons');

export type BrandIcon =
  | 'clipboard-list'
  | 'circle-check'
  | 'clock'
  | 'circle-x'
  | 'timer'
  | 'zap'
  | 'users'
  | 'camera'
  | 'camera-off'
  | 'triangle-alert'
  | 'user';

const svgCache = new Map<BrandIcon, string>();

function svgFor(name: BrandIcon): string {
  let svg = svgCache.get(name);
  if (!svg) {
    svg = readFileSync(join(ICONS_DIR, `${name}.svg`), 'utf8');
    svgCache.set(name, svg);
  }
  return svg;
}

/** A recolored Lucide icon as an inline pdfmake svg node. `marginTop`
 *  optically aligns the icon with text of a similar size next to it. */
export function iconNode(
  name: BrandIcon,
  color: string,
  size = 10,
  marginTop = 0,
): Content {
  return {
    svg: svgFor(name).replaceAll('currentColor', color),
    width: size,
    height: size,
    margin: [0, marginTop, 0, 0],
  };
}
