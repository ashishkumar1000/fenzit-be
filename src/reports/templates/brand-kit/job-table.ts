import type { Content, TableLayout, TableCell } from 'pdfmake/interfaces';
import {
  brand,
  statusColors,
  statusTints,
  TABLE,
  FONT_FAMILY,
} from './brand-theme';
import { FONT_SEMIBOLD } from './brand-assets';

/**
 * Branded job table (FR-T1) — quiet tinted header, zebra body with no
 * per-row rules (single stripe system), tinted status cells, and fixed
 * column widths so every technician's table aligns identically down the
 * page. The header row repeats automatically across page breaks
 * (`headerRows: 1`).
 */

export interface JobTableRow {
  jobNumber: string;
  /** Planned date + time, e.g. "20 Sep 16:30". */
  planned: string;
  customer: string;
  skill: string;
  status: string;
  /** Finish date + time (multi-day ranges make the date matter), or "—". */
  finish: string;
  /** Photo + signature count for the job. */
  proofs: number;
}

/** Fixed pt widths (content width 515): Customer takes the remainder (*).
 *  `noWrap` on the two time headers stops mid-word wrapping. */
const JOB_COLUMNS: {
  header: string;
  width: string | number;
  noWrap?: boolean;
}[] = [
  { header: 'Job', width: 38 },
  { header: 'Customer', width: '*' },
  { header: 'Skill', width: 80 },
  { header: 'Status', width: 58 },
  { header: 'Planned time', width: 72, noWrap: true },
  { header: 'Finish time', width: 78, noWrap: true },
  { header: 'Proofs', width: 34 },
];

export function jobsTable(rows: JobTableRow[]): Content {
  const headerCells: TableCell[] = JOB_COLUMNS.map((col) => ({
    text: col.header.toUpperCase(),
    fontSize: 7.5,
    font: FONT_SEMIBOLD,
    color: TABLE.headerText,
    characterSpacing: 0.5,
    noWrap: col.noWrap,
    fillColor: TABLE.headerBackground,
    margin: [4, 5, 4, 5],
  }));

  const bodyCells: TableCell[][] = rows.map((row, i) => {
    const zebra = i % 2 === 1 ? TABLE.zebraBackground : undefined;
    // Templates pass display labels ("In progress"); the kit resolves the
    // status token from the normalized label.
    const statusKey = row.status.toLowerCase().replace(/ /g, '_') as
      keyof typeof statusColors | 'unknown';
    const statusColor =
      statusColors[statusKey as keyof typeof statusColors] ?? brand.text;
    const statusTint =
      statusTints[statusKey as keyof typeof statusTints] ?? zebra;
    const plain = (
      text: string,
      color: string = brand.textBody,
      fill: string | undefined = zebra,
    ): TableCell => ({
      text,
      fontSize: 8.5,
      font: FONT_FAMILY,
      color,
      fillColor: fill,
      margin: [4, 4, 4, 4],
    });
    return [
      plain(row.jobNumber, brand.text),
      plain(row.customer),
      plain(row.skill),
      plain(row.status, statusColor, statusTint),
      plain(row.planned),
      plain(row.finish),
      plain(row.proofs > 0 ? String(row.proofs) : '—'),
    ];
  });

  return {
    table: {
      headerRows: 1,
      widths: JOB_COLUMNS.map((c) => c.width),
      body: [headerCells, ...bodyCells],
    },
    layout: tableLayout,
  };
}

/** One stripe system: zebra fills only — the only rule is the 0.75pt line
 *  under the header row (per-row h-lines + zebra was double striping). */
const tableLayout: TableLayout = {
  hLineWidth: (i) => (i === 1 ? TABLE.borderWidth : 0),
  vLineWidth: () => 0,
  hLineColor: () => brand.border,
  paddingLeft: () => 4,
  paddingRight: () => 4,
};
