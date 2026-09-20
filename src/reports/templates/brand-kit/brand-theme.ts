/**
 * Brand theme tokens (FR-T1) — the single source of brand styling for every
 * report PDF. Mirrors the Fenzit design system (fenzo-app/src/theme/colors.ts).
 * No template hard-codes a colour, font, or size — everything flows from here.
 */

/** Cool-gray scale (same values as the FE palette). */
export const gray = {
  0: '#FFFFFF',
  50: '#F9FAFB',
  100: '#F3F4F6',
  200: '#E5E7EB',
  300: '#D1D5DB',
  400: '#9CA3AF',
  500: '#6B7280',
  600: '#4B5563',
  700: '#374151',
  800: '#1F2937',
  900: '#111827',
} as const;

/** Brand anchors (PRD §5.2 theme block). */
export const brand = {
  primary: '#1A56DB',
  primaryTint: '#EFF4FE',
  done: '#06956F',
  scheduled: '#D97706',
  cancelled: '#C92A2A',
  background: gray[50],
  text: gray[900],
  textBody: gray[700],
  textMuted: gray[500],
  border: gray[200],
  surface: gray[0],
} as const;

/** Job status → report colour (matches the FE urgency/status semantics). */
export const statusColors = {
  completed: brand.done,
  in_progress: brand.scheduled,
  scheduled: brand.scheduled,
  cancelled: brand.cancelled,
  pending: brand.textMuted,
} as const;

/** Job status → light cell tint (the fill behind the status text; a tinted
 *  cell reads faster than coloured text alone in a dense table). */
export const statusTints = {
  completed: '#E0F2EC',
  in_progress: '#FCF1DE',
  scheduled: '#FCF1DE',
  cancelled: '#FBE9E9',
  pending: gray[100],
} as const;

/** Printable content width (A4 595pt − the left/right PAGE_MARGINS). */
export const CONTENT_WIDTH = 515;

/**
 * Inter is embedded as static TTFs (variable TTFs cannot map weights in
 * pdfmake). Keys are the pdfmake font-style names templates reference
 * (`font: FONT_FAMILY`, `bold: true` picks FONT_FAMILY-Bold, etc.).
 */
export const FONT_FAMILY = 'Inter';

/** A4 with balanced report margins (pdfmake units = pt). */
export const PAGE_MARGINS = {
  left: 40,
  top: 48,
  right: 40,
  bottom: 56,
} as const;

/** Summary cards: white surface + a hairline border, matching the FE metric
 *  cards (tinted icon chip on top, dark label, large value) — the colour
 *  lives in the icon chip and the value, not in a top bar. */
export const CARD = {
  background: brand.surface,
  borderColor: gray[200],
  borderWidth: 0.75,
  padding: 10,
} as const;

/** Table headers are a quiet tint with brand-coloured text — solid blue bars
 *  on every technician table shout over the data. */
export const TABLE = {
  headerBackground: brand.primaryTint,
  headerText: brand.primary,
  zebraBackground: gray[50],
  borderWidth: 0.75,
} as const;
