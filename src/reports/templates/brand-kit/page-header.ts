import type { Content, TableCell } from 'pdfmake/interfaces';
import { brand, FONT_FAMILY, PAGE_MARGINS, CONTENT_WIDTH } from './brand-theme';
import { logoDataUri, FONT_SEMIBOLD } from './brand-assets';

/**
 * Page header + footer (FR-T1) — tenant identity block at the top of page 1
 * and the page-number strip on every page. All styling from brand-theme.
 */

export interface HeaderTenant {
  companyName: string;
  address?: string | null;
}

export interface HeaderRange {
  /** IST calendar dates (YYYY-MM-DD), inclusive. */
  startDate: string;
  endDate: string;
}

const LOGO_SIZE = 30;

/** Branded header: logo + tenant identity, then the report title + range,
 *  closed by a short accent bar (not a full-width rule — calmer, and the bar
 *  reads as a designed edge rather than a divider). */
export function pageHeader(
  tenant: HeaderTenant,
  title: string,
  range: HeaderRange,
  subtitle?: string,
): Content {
  const identity: TableCell = {
    stack: [
      {
        text: tenant.companyName,
        fontSize: 13,
        font: FONT_SEMIBOLD,
        color: brand.text,
      },
      ...(tenant.address
        ? [
            {
              text: tenant.address,
              fontSize: 9,
              font: FONT_FAMILY,
              color: brand.textMuted,
            } satisfies Content,
          ]
        : []),
    ],
    alignment: 'left',
  };

  return {
    margin: [0, 0, 0, 14],
    stack: [
      {
        table: {
          widths: [LOGO_SIZE + 8, 'auto'],
          body: [
            [
              {
                image: logoDataUri,
                fit: [LOGO_SIZE, LOGO_SIZE],
                alignment: 'left',
              },
              identity,
            ],
          ],
        },
        layout: 'noBorders',
      },
      {
        text: title,
        fontSize: 18,
        font: FONT_SEMIBOLD,
        color: brand.text,
        margin: [0, 10, 0, 2],
      },
      {
        text: `${range.startDate} → ${range.endDate} (IST)`,
        fontSize: 10,
        font: FONT_FAMILY,
        color: brand.textMuted,
        margin: [0, 2, 0, 0],
      } satisfies Content,
      ...(subtitle
        ? [
            {
              text: subtitle,
              fontSize: 9,
              font: FONT_FAMILY,
              color: brand.textMuted,
              margin: [0, 1, 0, 8],
            } satisfies Content,
          ]
        : [{ text: '', margin: [0, 0, 0, 8] } satisfies Content]),
      {
        canvas: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: 44,
            h: 3,
            color: brand.primary,
          },
        ],
      } satisfies Content,
    ],
  };
}

/**
 * Footer callback (page numbers + creation timestamp + privacy note +
 * Fenzit wordmark). Timestamp is captured when the template builds the doc —
 * render time — formatted on the IST clock (no date library). Templates
 * assign this to the doc definition's `footer` field.
 */
export function pageFooter(): (
  currentPage: number,
  pageCount: number,
) => Content {
  const generatedAt = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');

  return (currentPage: number, pageCount: number): Content => ({
    margin: [PAGE_MARGINS.left, 0, PAGE_MARGINS.right, 12],
    stack: [
      {
        canvas: [
          {
            type: 'line',
            x1: 0,
            y1: 0,
            x2: CONTENT_WIDTH,
            y2: 0,
            lineWidth: 0.75,
            lineColor: brand.border,
          },
        ],
      } satisfies Content,
      {
        columns: [
          {
            text: `Created ${generatedAt} IST · Private — contains customer details`,
            fontSize: 7,
            font: FONT_FAMILY,
            color: brand.textMuted,
          },
          {
            text: `Fenzit · ${currentPage} / ${pageCount}`,
            fontSize: 7,
            font: FONT_SEMIBOLD,
            color: brand.textMuted,
            alignment: 'right',
          },
        ],
        margin: [0, 4],
      } satisfies Content,
    ],
  });
}
