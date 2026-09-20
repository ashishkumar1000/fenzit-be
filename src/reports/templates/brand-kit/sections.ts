import type { Content, TableLayout, TableCell } from 'pdfmake/interfaces';
import { brand, gray, TABLE, FONT_FAMILY } from './brand-theme';
import { FONT_SEMIBOLD } from './brand-assets';
import { iconNode, type BrandIcon } from './brand-icons';

/**
 * Section furniture (FR-T1) — section titles, empty states and the
 * "Needs attention" flag list. All styling from brand-theme.
 */

const SECTION_TITLE_SIZE = 12.5;

/** Branded section heading (Overall / per-technician sections), with an
 *  optional leading Lucide icon. Generous top margin separates sections
 *  without boxes or rules. */
export function sectionTitle(text: string, icon?: BrandIcon): Content {
  if (!icon) {
    return {
      text,
      fontSize: SECTION_TITLE_SIZE,
      font: FONT_SEMIBOLD,
      color: brand.primary,
      margin: [0, 14, 0, 8],
    };
  }
  return {
    margin: [0, 14, 0, 8],
    table: {
      widths: [18, 'auto'],
      body: [
        [
          iconNode(icon, brand.primary, 12, 1),
          {
            text,
            fontSize: SECTION_TITLE_SIZE,
            font: FONT_SEMIBOLD,
            color: brand.primary,
          } satisfies TableCell,
        ],
      ],
    },
    layout: iconRowLayout,
  };
}

const iconRowLayout: TableLayout = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: () => 0,
  paddingRight: () => 4,
  paddingTop: () => 0,
  paddingBottom: () => 0,
};

/** Empty-state row for a job table (zero-job technician section, FR18). */
export function emptyStateRow(message: string): Content {
  return {
    table: {
      widths: ['*'],
      body: [
        [
          {
            text: message,
            fontSize: 8.5,
            font: FONT_FAMILY,
            color: brand.textMuted,
            alignment: 'center',
            fillColor: TABLE.zebraBackground,
            margin: [4, 8, 4, 8],
          } satisfies TableCell,
        ],
      ],
    },
    layout: emptyStateLayout,
    margin: [0, 0, 0, 12],
  };
}

const emptyStateLayout: TableLayout = {
  hLineWidth: () => 0.75,
  vLineWidth: () => 0.75,
  hLineColor: () => brand.border,
  vLineColor: () => brand.border,
};

/** Full-width empty-state block (zero jobs in the whole period, FR18). */
export function emptyStateBlock(message: string): Content {
  return {
    table: {
      widths: ['*'],
      body: [
        [
          {
            text: message,
            fontSize: 13,
            font: FONT_SEMIBOLD,
            color: brand.textMuted,
            alignment: 'center',
            fillColor: TABLE.zebraBackground,
            margin: [24, 28, 24, 28],
          } satisfies TableCell,
        ],
      ],
    },
    layout: emptyStateLayout,
    margin: [0, 24, 0, 0],
  };
}

export interface FlagItem {
  /** Short concern label, e.g. "Overdue · J-1042". */
  title: string;
  /** One-line explanation of what the owner should look into. */
  detail: string;
  /** Severity colour for icon + title (the template decides — cancelled
   *  flags are informational, urgent ones are alarms). */
  color?: string;
  /** Optional Lucide icon shown in front of the row. */
  icon?: BrandIcon;
}

/** "Needs attention" list — borderless rows (icon + concern label +
 *  explanation); the row's colour carries its severity. */
export function flagList(items: FlagItem[]): Content {
  return {
    table: {
      widths: [16, 'auto', '*'],
      body: items.map((item) => [
        {
          stack: [
            iconNode(
              item.icon ?? 'triangle-alert',
              item.color ?? brand.cancelled,
              11,
              1,
            ),
          ],
          margin: [4, 4, 0, 4],
        } satisfies TableCell,
        {
          text: item.title,
          fontSize: 8.5,
          font: FONT_SEMIBOLD,
          color: item.color ?? brand.cancelled,
          margin: [4, 4, 12, 4],
        } satisfies TableCell,
        {
          text: item.detail,
          fontSize: 8.5,
          font: FONT_FAMILY,
          color: brand.textBody,
          margin: [4, 4, 4, 4],
        } satisfies TableCell,
      ]),
    },
    layout: flagLayout(items.length),
    margin: [0, 0, 0, 12],
  };
}

/** No rules between flag rows (colour + icon carry the severity); a hairline
 *  separates consecutive rows only when the list is long enough to need it. */
function flagLayout(count: number): TableLayout {
  return {
    hLineWidth: (i) => (count > 4 && i > 1 && i < count ? 0.5 : 0),
    vLineWidth: () => 0,
    hLineColor: () => gray[200],
    paddingLeft: () => 0,
    paddingRight: () => 0,
    paddingTop: () => 0,
    paddingBottom: () => 0,
  };
}
