import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FONT_FAMILY } from './brand-theme';

/**
 * Brand assets loader (FR-T1) — reads the logo once at module load and
 * locates the Inter TTFs. Fonts are exposed as absolute file paths (pdfmake
 * 0.3's Node path: URL resolution skips non-http sources and PDFKit opens
 * the file; Buffers are typed but crash Printer.resolveUrls — do not pass
 * Buffers). The logo goes out as a base64 data URI (image nodes take data
 * URIs). No per-render I/O. Missing fonts fail fast with a clear error.
 */

const ASSETS_DIR = join(__dirname, 'assets');

const PNG_DATA_URI_PREFIX = 'data:image/png;base64,';

/** The Fenzit logo as a pdfmake-ready data URI (templates embed it directly). */
export const logoDataUri =
  PNG_DATA_URI_PREFIX +
  readFileSync(join(ASSETS_DIR, 'fenzit-logo.png')).toString('base64');

/** TTF file names inside assets/fonts (static weights — see brand-theme). */
const FONT_FILES = {
  normal: 'Inter-Regular.ttf',
  semibold: 'Inter-SemiBold.ttf',
  bold: 'Inter-Bold.ttf',
} as const;

/** Absolute dir of the bundled TTFs — the renderer's local-access allowlist. */
export const fontsDir = join(ASSETS_DIR, 'fonts');

/**
 * pdfmake resolves weights through font families: `font: FONT_FAMILY` +
 * `bold: true` picks the bold TTF; `font: FONT_SEMIBOLD` picks the semibold
 * TTF directly (pdfmake has no per-family "semibold" style boolean).
 */
export const FONT_SEMIBOLD = 'Inter-SemiBold';

/**
 * Font dictionary (TFontDictionary shape) — variant → absolute TTF path.
 */
export const fontDescriptor: Record<string, Record<string, string>> = {
  [FONT_FAMILY]: {
    normal: join(fontsDir, FONT_FILES.normal),
    bold: join(fontsDir, FONT_FILES.bold),
  },
  [FONT_SEMIBOLD]: {
    normal: join(fontsDir, FONT_FILES.semibold),
  },
};
