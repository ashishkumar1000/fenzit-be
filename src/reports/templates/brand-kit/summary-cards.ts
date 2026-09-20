import type { Content, TableLayout, TableCell } from 'pdfmake/interfaces';
import { brand, gray, CARD, statusTints, FONT_FAMILY } from './brand-theme';
import { FONT_SEMIBOLD } from './brand-assets';
import { iconNode, type BrandIcon } from './brand-icons';

/**
 * Summary metric cards (FR-T1) — matching the FE metric-card design: a white
 * card with a hairline border, a tinted icon chip on top, a dark label, a
 * large accent-coloured value, and an optional small caption. A caption is
 * only ever real derived info (e.g. "25% finish rate") — never filler text.
 */

export interface SummaryCard {
  /** Sentence-case label, e.g. "Total jobs". */
  label: string;
  value: string;
  /** Value colour, e.g. completed green. Neutral dark when omitted. */
  accent?: string;
  /** Optional Lucide icon, drawn inside a tinted chip. */
  icon?: BrandIcon;
  /** Chip fill; derived from `accent` when omitted. */
  tint?: string;
  /** Chip icon stroke colour; derived from `accent` when omitted. */
  iconColor?: string;
  /** Small muted line under the value — real derived info only. */
  caption?: string;
}

const ACCENT_GAP = 6;

/** Icon chip fill for an accent colour (the FE pairs each status colour
 *  with its tint; neutral cards get a grey chip). */
function tintFor(accent?: string): string {
  if (!accent) return gray[100];
  if (accent === brand.done) return statusTints.completed;
  if (accent === brand.scheduled) return statusTints.scheduled;
  if (accent === brand.cancelled) return statusTints.cancelled;
  return brand.primaryTint;
}

/** Tinted rounded-look chip behind the icon (a small filled table cell —
 *  pdfmake cannot round corners, so the chip is square). `gapBelow` pushes
 *  the label down off the chip. */
function iconChip(
  icon: BrandIcon,
  tint: string,
  color: string,
  gapBelow = 0,
): Content {
  return {
    table: {
      widths: [16],
      body: [
        [
          {
            stack: [iconNode(icon, color, 9, 0)],
            alignment: 'center',
            fillColor: tint,
            margin: [3, 3, 3, 3],
          } satisfies TableCell,
        ],
      ],
    },
    layout: 'noBorders',
    margin: [0, 0, 0, gapBelow],
  };
}

/** One row of summary metric cards (Overall section, per-technician stats). */
export function summaryCardRow(cards: SummaryCard[]): Content {
  return {
    columns: cards.map((card) => ({
      table: {
        widths: ['*'],
        body: [[cardCell(card)]],
      },
      layout: cardLayout,
    })),
    columnGap: ACCENT_GAP,
    margin: [0, 0, 0, 12],
  };
}

function cardCell(card: SummaryCard): TableCell {
  const iconColor = card.iconColor ?? card.accent ?? brand.textBody;
  return {
    stack: [
      ...(card.icon
        ? [iconChip(card.icon, card.tint ?? tintFor(card.accent), iconColor, 5)]
        : []),
      {
        text: card.label,
        fontSize: 8.5,
        font: FONT_SEMIBOLD,
        color: brand.text,
      },
      {
        text: card.value,
        fontSize: 16,
        font: FONT_SEMIBOLD,
        color: card.accent ?? brand.text,
        margin: [0, 1, 0, 0],
      } satisfies Content,
      ...(card.caption
        ? [
            {
              text: card.caption,
              fontSize: 7.5,
              font: FONT_FAMILY,
              color: brand.textMuted,
              margin: [0, 2, 0, 0],
            } satisfies Content,
          ]
        : []),
    ],
    fillColor: CARD.background,
    margin: [CARD.padding, CARD.padding, CARD.padding, CARD.padding],
  };
}

/** Hairline border on every edge — the card reads on the white page through
 *  its border + chip, not through a fill (print-friendly, FE-matching). */
const cardLayout: TableLayout = {
  hLineWidth: () => CARD.borderWidth,
  vLineWidth: () => CARD.borderWidth,
  hLineColor: () => CARD.borderColor,
  vLineColor: () => CARD.borderColor,
  paddingLeft: () => CARD.padding,
  paddingRight: () => CARD.padding,
  paddingTop: () => CARD.padding,
  paddingBottom: () => CARD.padding,
};
