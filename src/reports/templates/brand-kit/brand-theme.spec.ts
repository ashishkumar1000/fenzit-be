import {
  gray,
  brand,
  statusColors,
  statusTints,
  CONTENT_WIDTH,
  PAGE_MARGINS,
  FONT_FAMILY,
  CARD,
  TABLE,
} from './brand-theme';

/**
 * Brand tokens are the single styling source for every template — these tests
 * lock the structural invariants other kit files rely on (derived tokens, the
 * status colour/tint pairing, and the A4 width maths), not the literal hex
 * values themselves.
 */

/** A4 page width in pdfmake points — CONTENT_WIDTH is derived from it. */
const A4_WIDTH_PT = 595;

describe('brand-theme — token structure', () => {
  it('derives CONTENT_WIDTH from the A4 width minus the page margins', () => {
    // The kit's fixed table widths (job-table, footer line) are computed
    // against this number — if it drifts from the actual printable width,
    // tables silently overflow the page.
    expect(CONTENT_WIDTH).toBe(
      A4_WIDTH_PT - PAGE_MARGINS.left - PAGE_MARGINS.right,
    );
  });

  it('derives the neutral tokens from the gray scale, not from literals', () => {
    // Templates style against brand.* — these must stay aliases of the scale
    // so re-tuning one gray propagates everywhere.
    expect(brand.background).toBe(gray[50]);
    expect(brand.surface).toBe(gray[0]);
    expect(brand.text).toBe(gray[900]);
    expect(brand.textBody).toBe(gray[700]);
    expect(brand.textMuted).toBe(gray[500]);
    expect(brand.border).toBe(gray[200]);
  });

  it('pairs every status colour with a tint under the same key', () => {
    // job-table reads statusTints[key] for the cell behind statusColors[key]
    // text — a missing tint key would silently drop the fill for one status.
    expect(Object.keys(statusColors).sort()).toEqual(
      Object.keys(statusTints).sort(),
    );
  });

  it('maps each status to its FE-matching colour and tint family', () => {
    expect(statusColors.completed).toBe(brand.done);
    expect(statusColors.in_progress).toBe(brand.scheduled);
    expect(statusColors.scheduled).toBe(brand.scheduled);
    expect(statusColors.cancelled).toBe(brand.cancelled);
    expect(statusColors.pending).toBe(brand.textMuted);

    // in_progress and scheduled share the amber family end to end.
    expect(statusTints.completed).not.toBe(statusTints.scheduled);
    expect(statusTints.in_progress).toBe(statusTints.scheduled);
    expect(statusTints.pending).toBe(gray[100]);
  });

  it('keeps every colour token a 6-digit hex (pdfmake rejects anything else)', () => {
    const tokens: string[] = [
      ...Object.values(gray),
      ...Object.values(brand),
      ...Object.values(statusColors),
      ...Object.values(statusTints),
    ];
    for (const token of tokens) {
      expect(token).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('exposes card and table furniture as positive physical values', () => {
    expect(CARD.borderWidth).toBeGreaterThan(0);
    expect(CARD.padding).toBeGreaterThan(0);
    expect(TABLE.borderWidth).toBeGreaterThan(0);
    expect(typeof FONT_FAMILY).toBe('string');
  });
});