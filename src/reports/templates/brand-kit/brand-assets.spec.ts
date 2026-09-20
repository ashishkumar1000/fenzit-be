import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  logoDataUri,
  fontDescriptor,
  fontsDir,
  FONT_SEMIBOLD,
} from './brand-assets';
import { FONT_FAMILY } from './brand-theme';

/**
 * The assets loader is the file/IO boundary of the brand kit — these tests
 * lock the contract the renderer and pdfmake depend on: the logo is a pdfmake
 * data-URI image, and the fonts are absolute TTF PATHS on disk (the known
 * pdfmake 0.3 gotcha — Buffers are typed but crash Printer.resolveUrls).
 */

describe('brand-assets', () => {
  it('exposes the logo as a base64 PNG data URI pdfmake can embed', () => {
    expect(logoDataUri.startsWith('data:image/png;base64,')).toBe(true);

    const base64 = logoDataUri.slice('data:image/png;base64,'.length);
    const bytes = Buffer.from(base64, 'base64');
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
    );
  });

  it('exposes fonts as absolute file paths that exist on disk', () => {
    const entries = Object.entries(fontDescriptor).flatMap(([, variants]) =>
      Object.entries(variants),
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const [, path] of entries) {
      expect(typeof path).toBe('string');
      expect(isAbsolute(path)).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(path.endsWith('.ttf')).toBe(true);
    }
  });

  it('registers the Inter family with normal + bold, semibold as its own family', () => {
    // pdfmake resolves weights through families: `bold: true` picks the Bold
    // TTF of FONT_FAMILY, and FONT_SEMIBOLD is a separate family because
    // pdfmake has no per-family "semibold" style boolean.
    expect(fontDescriptor[FONT_FAMILY]).toEqual({
      normal: expect.stringContaining('Inter-Regular.ttf'),
      bold: expect.stringContaining('Inter-Bold.ttf'),
    });
    expect(fontDescriptor[FONT_SEMIBOLD]).toEqual({
      normal: expect.stringContaining('Inter-SemiBold.ttf'),
    });
    expect(FONT_SEMIBOLD).not.toBe(FONT_FAMILY);
  });

  it('points fontsDir at the shared TTF directory (the renderer allowlist root)', () => {
    for (const variants of Object.values(fontDescriptor)) {
      for (const path of Object.values(variants)) {
        expect(path.startsWith(fontsDir)).toBe(true);
      }
    }
  });
});