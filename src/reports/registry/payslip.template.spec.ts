import { buildPayslipDocument, resolvedPayDate } from './payslip.template';
import type { PayslipSnapshot } from './payslip.data';
import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';

/**
 * Template assembly test for the Form V payslip PDF (story 23-8). Same
 * discipline as the sibling template specs: the brand-kit builders run
 * real, assertions pin the SECTION CONTRACT (Form V's mandated fields and
 * the plan's field map) — never the incidental layout. The deduction table
 * contract is the load-bearing one: a column-rendered source (esi,
 * pf_employee, tds) must render exactly once, from its snapshot column.
 */

jest.mock('../templates/brand-kit/brand-assets', () => ({
  logoDataUri: 'data:image/png;base64,MOCKLOGO',
  FONT_SEMIBOLD: 'Inter-SemiBold',
}));

function fixture(over: Partial<PayslipSnapshot> = {}): PayslipSnapshot {
  return {
    id: '00000000-0000-4000-8000-0000000000f1',
    run_id: 'run-uuid',
    membership_id: 'member-uuid',
    salary_period: '2026-10',
    slip_number: 'PS-001',
    employee_name: 'Asha Nair',
    employee_code: 'EMP-001',
    father_name: 'Raman Nair',
    mother_name: 'Devi Nair',
    spouse_name: null,
    designation: 'Technician',
    department: 'Service',
    pan: 'ABCDE1234F',
    uan_number: '101010101010',
    bank_account_number: '1234567890',
    ifsc_code: 'HDFC0000123',
    bank_name: 'HDFC Bank',
    date_of_joining: '2025-04-01',
    establishment_name: 'Fenzit Services Pvt Ltd',
    establishment_address: '12 MG Road, Bengaluru 560001',
    wage_period_start: '2026-10-01',
    wage_period_end: '2026-10-31',
    divisor_convention: 'calendar',
    cutoff_day: 25,
    pay_date: 5,
    payable_days: 30,
    lop_days: 1,
    paid_days: 29,
    days_worked: 29,
    gross_earnings: 10000,
    pf_employee: 780,
    pf_employer: 780,
    tds: 500,
    other_deductions: 350,
    total_deductions: 1770,
    net_wages: 8230,
    earning_lines: [
      { name: 'Basic', amount: 6000 },
      { name: 'HRA', amount: 4000 },
    ],
    deduction_lines: [
      { source: 'pf_employee', amount: 780 },
      { source: 'esi', amount: 140 },
      { source: 'tds', amount: 500 },
      { source: 'head:Insurance', amount: 250 },
      { source: 'recovery:2026-09', amount: 100 },
    ],
    ...over,
  };
}

/** Every text string in the assembled document tree. */
function allTexts(doc: { content: unknown }): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (typeof o.text === 'string') out.push(o.text);
      if (o.table) walk((o.table as Record<string, unknown>).body);
      if (o.stack) walk(o.stack);
      if (o.columns) walk(o.columns);
      walk(o.content);
    }
  };
  walk(doc.content);
  return out;
}

const has = (texts: string[], needle: string) =>
  texts.some((t) => t.includes(needle));

describe('buildPayslipDocument (23-8)', () => {
  it('stays A4 portrait with the standard margins and the wage-privacy footer', () => {
    const doc = buildPayslipDocument(fixture());
    expect(doc.pageSize).toBe('A4');
    expect(Array.isArray(doc.pageMargins)).toBe(true);
    expect(doc.footer).toBeDefined();
    const strip = (doc.footer as (p: number, t: number) => unknown)(1, 9) as {
      stack: [{ columns: [{ text: string }, unknown] }];
    };
    expect(strip.stack[1].columns[0].text).toContain(
      'Private — contains employee wage details',
    );
  });

  it('cites Form V under the Code on Wages (Central) Rules, 2026 — not the Contract Labour rules', () => {
    const texts = allTexts(buildPayslipDocument(fixture()));
    expect(has(texts, 'Form V · Code on Wages (Central) Rules, 2026, rule 52')).toBe(
      true,
    );
    expect(has(texts, 'Contract Labour')).toBe(false);
  });

  it('dates of issue and payment = the resolved pay date: the month AFTER salary_period', () => {
    const texts = allTexts(buildPayslipDocument(fixture()));
    // October 2026 wages, pay day 5 → issued 05 November 2026.
    expect(has(texts, 'Date of issue: 05 November 2026')).toBe(true);
    expect(has(texts, 'Payment date')).toBe(true);
    expect(has(texts, '05 November 2026')).toBe(true);
    expect(has(texts, '05 October 2026')).toBe(false);
  });

  it('resolvedPayDate rolls December into January of the next year', () => {
    expect(resolvedPayDate('2026-12', 7)).toBe('07 January 2027');
    expect(resolvedPayDate('2026-10', 5)).toBe('05 November 2026');
    // A null pay day reads as day 1 — never NaN.
    expect(resolvedPayDate('2026-10', null)).toBe('01 November 2026');
  });

  it('renders the wage-rate break-up from earning_lines with the gross row', () => {
    const texts = allTexts(buildPayslipDocument(fixture()));
    expect(has(texts, 'Basic')).toBe(true);
    expect(has(texts, 'HRA')).toBe(true);
    expect(has(texts, 'Gross wages payable')).toBe(true);
    expect(has(texts, '10,000.00')).toBe(true);
    // Indian digit grouping, not western: no "10,000.00" done as 10000.00
    expect(has(texts, '6000.00')).toBe(false);
    expect(has(texts, '6,000.00')).toBe(true);
  });

  it('renders each deduction ONCE — counted, not existence-checked', () => {
    const texts = allTexts(buildPayslipDocument(fixture()));
    // A double-render regression (PF/TDS rendering again as stored lines)
    // must FAIL here — `has()` alone cannot see a second row.
    expect(texts.filter((t) => t === 'Employee PF contribution')).toHaveLength(1);
    expect(texts.filter((t) => t === 'ESI')).toHaveLength(1);
    expect(texts.filter((t) => t === 'TDS (income tax)')).toHaveLength(1);
    expect(texts.filter((t) => t === 'Total deductions')).toHaveLength(1);
    expect(texts.filter((t) => t === '780.00')).toHaveLength(1); // PF column value
    expect(texts.filter((t) => t === '140.00')).toHaveLength(1); // ESI line value
    expect(texts.filter((t) => t === '500.00')).toHaveLength(1); // TDS column value
    expect(has(texts, '1,770.00')).toBe(true);
    // No column-rendered source renders AGAIN as a stored line: the raw
    // sources never appear as row labels.
    expect(has(texts, 'pf_employee')).toBe(false);
    expect(has(texts, 'tds')).toBe(false);
    expect(has(texts, '\nesi')).toBe(false);
  });

  it('labels head and recovery lines humanly — head:Insurance → Insurance, recovery:2026-09 → Recovery (2026-09)', () => {
    const texts = allTexts(buildPayslipDocument(fixture()));
    expect(has(texts, 'Insurance')).toBe(true);
    expect(has(texts, '250.00')).toBe(true);
    expect(has(texts, 'Recovery (2026-09)')).toBe(true);
    expect(has(texts, '100.00')).toBe(true);
    expect(has(texts, 'head:Insurance')).toBe(false);
    expect(has(texts, 'recovery:2026-09')).toBe(false);
  });

  it('matches ESI through the head: prefix too (head:esi normalises to esi)', () => {
    const lines = fixture().deduction_lines.filter((l) => l.source !== 'esi');
    lines.push({ source: 'head:esi', amount: 140 });
    const texts = allTexts(buildPayslipDocument(fixture({ deduction_lines: lines })));
    // One ESI row, from the normalised line — not a second, and the bare
    // 'esi' source never leaks as a label.
    expect(texts.filter((t) => t === 'ESI')).toHaveLength(1);
    expect(has(texts, '140.00')).toBe(true);
  });

  it('renders ESI as ₹0.00 when no esi line exists (best-effort matching, no fabrication)', () => {
    const lines = fixture().deduction_lines.filter((l) => l.source !== 'esi');
    const texts = allTexts(buildPayslipDocument(fixture({ deduction_lines: lines })));
    expect(has(texts, 'ESI')).toBe(true);
    // The EXACT cell: a substring ('0.00') would match any amount ending
    // in .00 — the ESI row's value must literally be 0.00.
    expect(texts).toContain('0.00');
    expect(has(texts, '140.00')).toBe(false);
  });

  it('carries the attendance block: payable / LOP / paid / days worked, overtime ₹0.00', () => {
    const texts = allTexts(buildPayslipDocument(fixture()));
    expect(has(texts, 'Payable days')).toBe(true);
    expect(has(texts, 'Loss-of-pay days')).toBe(true);
    expect(has(texts, 'Paid days')).toBe(true);
    expect(has(texts, 'Days worked')).toBe(true);
    expect(has(texts, 'Overtime')).toBe(true);
    expect(has(texts, '₹0.00')).toBe(true);
  });

  it('renders the establishment header and the net-wages band', () => {
    const texts = allTexts(buildPayslipDocument(fixture()));
    expect(has(texts, 'Fenzit Services Pvt Ltd')).toBe(true);
    expect(has(texts, '12 MG Road, Bengaluru 560001')).toBe(true);
    expect(has(texts, 'Net wages paid')).toBe(true);
    expect(has(texts, '₹8,230.00')).toBe(true);
  });

  it('pins the identity block and every documented null branch', () => {
    const texts = allTexts(
      buildPayslipDocument(
        fixture({
          pan: null,
          spouse_name: null,
          days_worked: null,
          wage_period_start: null,
          wage_period_end: null,
          establishment_address: null,
        }),
      ),
    );
    // Identity block off the snapshot columns (Form V's mandated fields).
    expect(has(texts, 'Raman Nair')).toBe(true);
    expect(has(texts, 'Devi Nair')).toBe(true);
    expect(has(texts, 'Technician')).toBe(true);
    expect(has(texts, 'Service')).toBe(true);
    expect(has(texts, '101010101010')).toBe(true); // UAN
    expect(has(texts, '1234567890')).toBe(true); // bank account number
    expect(has(texts, 'HDFC0000123')).toBe(true);
    expect(has(texts, 'HDFC Bank')).toBe(true);
    expect(has(texts, '2025-04-01')).toBe(true); // date of joining
    // PAN missing renders BLANK — the row stays, nothing is fabricated.
    const panIndex = texts.indexOf('PAN');
    expect(panIndex).toBeGreaterThanOrEqual(0);
    expect(texts[panIndex + 1]).toBe('');
    // Spouse missing → a blank cell, same contract.
    const spouseIndex = texts.indexOf("Spouse's name");
    expect(texts[spouseIndex + 1]).toBe('');
    // days_worked null → the em-dash placeholder, never 0.
    expect(has(texts, 'Days worked')).toBe(true);
    expect(has(texts, '—')).toBe(true);
    // No stored wage-period range → the salary month labels the period.
    expect(has(texts, '2026-10-01 to 2026-10-31')).toBe(false);
    // No address column → no address line under the establishment name.
    expect(has(texts, '12 MG Road')).toBe(false);
    // Warnings live on the run summary, never fabricated on the slip.
    expect(has(texts, 'warning')).toBe(false);
  });

  it('footnotes the slip number and the snapshot month it is final for', () => {
    const texts = allTexts(buildPayslipDocument(fixture()));
    expect(
      has(
        texts,
        'Slip PS-001 · generated from the payroll snapshot for 2026-10',
      ),
    ).toBe(true);
  });

  it('refuses an incomplete snapshot with REPORT_GENERATION_FAILED', () => {
    expect(() => buildPayslipDocument(null)).toThrow(BadRequestException);
    try {
      buildPayslipDocument({ salary_period: '2026-10' });
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({
        error_code: ErrorCode.REPORT_GENERATION_FAILED,
      });
    }
  });
});
