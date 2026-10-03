import type { Content, TableLayout, TableCell } from 'pdfmake/interfaces';
import { brand, gray, TABLE, FONT_FAMILY } from './brand-theme';
import { FONT_SEMIBOLD } from './brand-assets';

/**
 * Generic branded data table (21-3) — the job-table's visual system
 * (quiet tinted header, zebra body, header row repeating across page
 * breaks) without its job-specific status cells. Attendance tables and
 * future reports compose this with their own columns; the kit keeps
 * owning every colour, font and rule.
 */

export interface DataTableColumn {
  header: string;
  width: number | string;
  noWrap?: boolean;
  align?: 'left' | 'center' | 'right';
}

/** A cell value: a plain string, or an object styling the text. */
export type DataTableCell =
  | string
  | {
      text: string;
      color?: string;
      bold?: boolean;
      fontSize?: number;
      alignment?: 'left' | 'center' | 'right';
      fillColor?: string;
    };

export function dataTable(
  columns: DataTableColumn[],
  rows: DataTableCell[][],
): Content {
  const headerCells: TableCell[] = columns.map((col) => ({
    text: col.header.toUpperCase(),
    fontSize: 7.5,
    font: FONT_SEMIBOLD,
    color: TABLE.headerText,
    characterSpacing: 0.5,
    noWrap: col.noWrap,
    alignment: col.align,
    fillColor: TABLE.headerBackground,
    margin: [4, 5, 4, 5],
  }));

  const bodyCells: TableCell[][] = rows.map((row, i) => {
    const zebra = i % 2 === 1 ? TABLE.zebraBackground : undefined;
    return row.map((value, col) => {
      const colDef = columns[col];
      const cell =
        typeof value === 'string'
          ? { text: value }
          : value;
      return {
        text: cell.text,
        fontSize: cell.fontSize ?? 8.5,
        font: cell.bold ? FONT_SEMIBOLD : FONT_FAMILY,
        color: cell.color ?? brand.textBody,
        alignment: cell.alignment ?? colDef.align,
        noWrap: colDef.noWrap && cell.text !== '—',
        fillColor: cell.fillColor ?? zebra,
        margin: [4, 4, 4, 4],
      } satisfies TableCell;
    });
  });

  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: columns.map((c) => c.width),
      body: [headerCells, ...bodyCells],
    },
    layout: dataTableLayout,
    margin: [0, 0, 0, 12],
  };
}

/** Quiet grid: hairlines under the header and between body rows, single
 *  vertical rules at the page edges only (the zebra stripe carries the row). */
/** Same hairline colour the other kit tables use between body rows. */
const grayHairline = gray[200];

const dataTableLayout: TableLayout = {
  hLineWidth: (i, node) =>
    i === 0 || i === 1 || i === node.table.body.length ? 0.75 : 0.5,
  hLineColor: (i) => (i === 0 ? brand.border : grayHairline),
  vLineWidth: (i, node) =>
    i === 0 || i === (node.table.widths?.length ?? 0) ? 0.75 : 0,
  vLineColor: () => brand.border,
  paddingLeft: () => 4,
  paddingRight: () => 4,
  paddingTop: () => 2,
  paddingBottom: () => 2,
};
