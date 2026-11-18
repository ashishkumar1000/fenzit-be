import type { Content } from 'pdfmake/interfaces';
import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  brand,
  gray,
  FONT_FAMILY,
  PAGE_MARGINS,
} from '../templates/brand-kit/brand-theme';
import { FONT_SEMIBOLD } from '../templates/brand-kit/brand-assets';
import { dataTable, pageFooter, sectionTitle } from '../templates/brand-kit/page-chrome';
import type { ReportDocument } from './report-definition';
import type { PayslipSnapshot } from './payslip.data';

/**
 * Form V wage-slip template (23-8, CoW rule 52). Renders ONLY from the
 * snapshot row the fetcher read — every amount is a stored column or line,
 * never recomputed here. Field map:
 *  - Date of issue = the resolved pay date (house reading, recorded): the
 *    month AFTER salary_period, day = the stored pay_date int (1-7) — the
 *    slip is deemed issued with the wage payment (electronic issuance);
 *    December→January rollover. The payment date renders the same value.
 *  - Establishment name + address from the snapshot columns.
 *  - Employee identity: name, father's/mother's/spouse name, designation,
 *    UAN, bank account number (+ code, PAN, join date as product extras).
 *  - Wage-rate break-up = earning_lines (their sum IS gross_earnings —
 *    the per-line rounding contract).
 *  - Total attendance = payable / LOP / paid days + days worked; overtime
 *    ₹0.00 (no overtime surface exists).
 *  - Deductions: PF (pf_employee), ESI = the deduction line whose source
 *    normalises (trim, case-insensitive, "head:" stripped) to "esi" — else
 *    ₹0.00 (best-effort name matching; no ESI computation exists), TDS =
 *    the tds column, then each remaining head/recovery line by name.
 *  - Net wages paid = net_wages. PAN missing renders BLANK — the warning
 *    lives on the run summary, never fabricated on the slip.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** pdfmake's Margins is a fixed tuple — arrays lose that in inference. */
function margins(a: number, b: number, c: number, d: number): [number, number, number, number] {
  return [a, b, c, d];
}

/** ₹ with Indian digit grouping — the slip's every money cell. */
function inr(amount: number): string {
  return amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** "01 November 2026" — the resolved pay date off the snapshot (salary
 *  period + stored pay day), with the December→January rollover. */
export function resolvedPayDate(
  salaryPeriod: string,
  payDate: number | null,
): string {
  const [year, month] = salaryPeriod.split('-').map(Number);
  const day = payDate ?? 1;
  // month is 1-based here: Date.UTC's month index takes it as-is, so 12
  // (December) rolls into January of the next year.
  const resolved = new Date(Date.UTC(year, month, day));
  return `${String(resolved.getUTCDate()).padStart(2, '0')} ${MONTHS[resolved.getUTCMonth()]} ${resolved.getUTCFullYear()}`;
}

/** A head/recovery source as a human label: "head:Insurance" → "Insurance",
 *  "recovery:2026-09" → "Recovery (2026-09)". */
function deductionLabel(source: string): string {
  if (source.startsWith('recovery:')) {
    return `Recovery (${source.slice('recovery:'.length)})`;
  }
  return source.startsWith('head:') ? source.slice('head:'.length) : source;
}

/** "esi" under the agreed normalisation: strip the head: prefix, trim,
 *  lower-case (a saved head is recorded as `head:<name>`). */
function normalisedSource(source: string): string {
  return source.replace(/^head:/, '').trim().toLowerCase();
}

function blank(value: string | null | undefined): string {
  return value == null || value.trim() === '' ? '' : value.trim();
}

function dash(value: string | null | undefined): string {
  return value == null || value.trim() === '' ? '—' : value.trim();
}

/** Label/value pairs as a hairline two-column table. */
function kvTable(pairs: Array<[string, string]>): Content {
  return {
    table: {
      widths: [150, 'auto'],
      body: pairs.map(([label, value]) => [
        {
          text: label,
          color: brand.textMuted,
          fontSize: 8.5,
          font: FONT_SEMIBOLD,
        },
        { text: value === '' ? '' : value, fontSize: 9.5 },
      ]),
    },
    layout: {
      hLineStyle: () => ({ color: gray[200], lineWidth: 0.5 }),
      vLineStyle: () => null,
      paddingLeft: () => 0,
      paddingRight: () => 6,
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
    // Blank PAN stays blank: an empty second cell must not collapse the row.
    dontBreakRows: true,
  } as Content;
}

export function buildPayslipDocument(data: unknown): ReportDocument {
  const slip = data as PayslipSnapshot | null;
  if (
    !slip ||
    typeof slip.slip_number !== 'string' ||
    typeof slip.salary_period !== 'string'
  ) {
    throw new BadRequestException({
      error_code: ErrorCode.REPORT_GENERATION_FAILED,
      message: 'The payslip snapshot is incomplete — the PDF cannot be built',
    });
  }

  const payDate = resolvedPayDate(slip.salary_period, slip.pay_date);
  const periodLabel =
    slip.wage_period_start && slip.wage_period_end
      ? `${slip.wage_period_start} to ${slip.wage_period_end}`
      : slip.salary_period;

  // -- deductions -------------------------------------------------------
  // A source rendered from a snapshot COLUMN must not render again as a
  // stored line — the run engine records pf_employee and tds in
  // deduction_lines too (and the PF override/recovery machinery), so the
  // "others" filter drops every column-rendered source, not just ESI.
  const COLUMN_RENDERED_SOURCES = new Set(['esi', 'pf_employee', 'tds']);
  const esiLine = slip.deduction_lines.find(
    (line) => normalisedSource(line.source) === 'esi',
  );
  const esiAmount = esiLine ? Number(esiLine.amount) : 0;
  const otherLines = slip.deduction_lines.filter(
    (line) => !COLUMN_RENDERED_SOURCES.has(normalisedSource(line.source)),
  );

  const deductionRows = [
    ['Employee PF contribution', inr(Number(slip.pf_employee))],
    ['ESI', inr(esiAmount)],
    ['TDS (income tax)', inr(Number(slip.tds))],
    ...otherLines.map((line) => [
      deductionLabel(line.source),
      inr(Number(line.amount)),
    ]),
    ['Total deductions', inr(Number(slip.total_deductions))],
  ];

  // -- wage-rate break-up ----------------------------------------------
  const earningRows = slip.earning_lines.map((line) => [
    line.name,
    inr(Number(line.amount)),
  ]);

  const content: Content[] = [
    // Establishment header + date of issue (Form V's first mandated field).
    {
      columns: [
        {
          stack: [
            {
              text: blank(slip.establishment_name) || '—',
              fontSize: 15,
              font: FONT_SEMIBOLD,
              color: brand.text,
            },
            ...(slip.establishment_address
              ? [
                  {
                    text: slip.establishment_address,
                    fontSize: 9,
                    color: brand.textMuted,
                    margin: margins(0, 2, 0, 0),
                  },
                ]
              : []),
          ],
          width: '*',
        },
        {
          stack: [
            {
              text: 'Wage Slip',
              fontSize: 12,
              font: FONT_SEMIBOLD,
              color: brand.primary,
              alignment: 'right',
            },
            {
              text: 'Form V · Code on Wages (Central) Rules, 2026, rule 52',
              fontSize: 8,
              color: brand.textMuted,
              alignment: 'right',
            },
            {
              text: `Date of issue: ${payDate}`,
              fontSize: 9,
              color: brand.textBody,
              alignment: 'right',
              margin: margins(0, 4, 0, 0),
            },
          ],
          width: 'auto',
        },
      ],
      margin: margins(0, 0, 0, 10),
    },
    {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: brand.border }],
      margin: margins(0, 0, 0, 10),
    },
    sectionTitle('Employee', 'user'),
    kvTable([
      ['Employee name', blank(slip.employee_name)],
      ["Father's name", blank(slip.father_name)],
      ["Mother's name", blank(slip.mother_name)],
      ["Spouse's name", blank(slip.spouse_name)],
      ['Designation', blank(slip.designation)],
      ['Department', blank(slip.department)],
      ['Employee code', blank(slip.employee_code)],
      ['PAN', blank(slip.pan)],
      ['UAN', blank(slip.uan_number)],
      ['Bank account number', blank(slip.bank_account_number)],
      ['IFSC code', blank(slip.ifsc_code)],
      ['Bank name', blank(slip.bank_name)],
      ['Date of joining', dash(slip.date_of_joining)],
    ]),
    sectionTitle('Wage period'),
    kvTable([
      ['Wage period', periodLabel],
      ['Wage month', slip.salary_period],
      ['Slip number', slip.slip_number],
      ['Payment date', payDate],
      ['Wage divisor', dash(slip.divisor_convention)],
      ['Attendance cut-off day', slip.cutoff_day == null ? '—' : String(slip.cutoff_day)],
    ]),
    sectionTitle('Wage-rate break-up'),
    dataTable(
      [
        { header: 'Component', width: '*' },
        { header: 'Earned amount (₹)', width: 130, align: 'right' },
      ],
      [
        ...earningRows.map((row) => [{ text: row[0] }, { text: row[1], alignment: 'right' as const }]),
        [
          { text: 'Gross wages payable', bold: true, fontSize: 9.5 },
          {
            text: inr(Number(slip.gross_earnings)),
            bold: true,
            fontSize: 9.5,
            alignment: 'right',
          },
        ],
      ],
    ),
    sectionTitle('Total attendance'),
    kvTable([
      ['Payable days', String(Number(slip.payable_days))],
      ['Loss-of-pay days', String(Number(slip.lop_days))],
      ['Paid days', String(Number(slip.paid_days))],
      ['Days worked', slip.days_worked == null ? '—' : String(Number(slip.days_worked))],
      ['Overtime', '₹0.00'],
    ]),
    sectionTitle('Deductions'),
    dataTable(
      [
        { header: 'Deduction', width: '*' },
        { header: 'Amount (₹)', width: 130, align: 'right' },
      ],
      deductionRows.map((row, index) => [
        {
          text: row[0],
          bold: index === deductionRows.length - 1,
        },
        {
          text: row[1],
          alignment: 'right' as const,
          bold: index === deductionRows.length - 1,
        },
      ]),
    ),
    {
      table: {
        widths: ['*', 150],
        body: [
          [
            {
              text: 'Net wages paid',
              bold: true,
              fontSize: 11,
              color: gray[0],
              fillColor: brand.primary,
            },
            {
              text: `₹${inr(Number(slip.net_wages))}`,
              bold: true,
              fontSize: 11,
              color: gray[0],
              fillColor: brand.primary,
              alignment: 'right',
            },
          ],
        ],
      },
      layout: {
        hLineStyle: () => null,
        vLineStyle: () => null,
        paddingLeft: () => 8,
        paddingRight: () => 8,
        paddingTop: () => 7,
        paddingBottom: () => 7,
      },
      margin: margins(0, 6, 0, 0),
    },
    {
      text: `Slip ${slip.slip_number} · generated from the payroll snapshot for ${slip.salary_period} — the amounts are final for the run that issued this slip.`,
      fontSize: 8,
      color: brand.textMuted,
      margin: margins(0, 12, 0, 0),
    },
  ];

  return {
    pageSize: 'A4',
    pageMargins: [
      PAGE_MARGINS.left,
      PAGE_MARGINS.top,
      PAGE_MARGINS.right,
      PAGE_MARGINS.bottom,
    ],
    defaultStyle: {
      font: FONT_FAMILY,
      fontSize: 9.5,
      color: brand.textBody,
    },
    footer: pageFooter('Private — contains employee wage details'),
    content,
  };
}
