import { brand, statusColors, statusTints, TABLE, FONT_FAMILY } from './brand-theme';
import { FONT_SEMIBOLD } from './brand-assets';
import { jobsTable, JobTableRow } from './job-table';

/**
 * The branded job table — these tests lock the contract the technician report
 * (story 12-5) composes against: fixed column widths independent of the data
 * (so every technician's table aligns identically), the repeated header row,
 * the zebra stripe system, and the status→colour/tint resolution from display
 * labels.
 */

interface FlatCell {
  text: string;
  color: string;
  fillColor: string | undefined;
  font: string;
}

function cellsOf(node: ReturnType<typeof jobsTable>) {
  const table = (node as unknown as {
    table: { headerRows: number; widths: unknown[]; body: FlatCell[][] };
  }).table;
  return table;
}

const row: JobTableRow = {
  jobNumber: 'J-1042',
  planned: '20 Sep 16:30',
  customer: 'Priya Sharma',
  skill: 'AC repair',
  status: 'In progress',
  finish: '—',
  proofs: 2,
};

describe('jobsTable — structure', () => {
  it('emits the fixed 7-column layout with a repeating header row', () => {
    const table = cellsOf(jobsTable([row]));

    expect(table.headerRows).toBe(1);
    expect(table.widths).toEqual([38, '*', 80, 58, 72, 78, 34]);
    expect(table.body).toHaveLength(2); // header + 1 job
  });

  it('labels the headers in plain English, uppercased', () => {
    const [header] = cellsOf(jobsTable([])).body;

    expect(header.map((cell) => cell.text)).toEqual([
      'JOB',
      'CUSTOMER',
      'SKILL',
      'STATUS',
      'PLANNED TIME',
      'FINISH TIME',
      'PROOFS',
    ]);
    for (const cell of header) {
      expect(cell.font).toBe(FONT_SEMIBOLD);
      expect(cell.color).toBe(TABLE.headerText);
      expect(cell.fillColor).toBe(TABLE.headerBackground);
    }
  });

  it('keeps column widths stable regardless of the data (long values wrap, never widen)', () => {
    const longRow: JobTableRow = {
      jobNumber: 'J-10429999',
      planned: '30 September 2026 16:30 IST',
      customer: 'Priyadarshini Venkataramanan Estates Pvt Ltd',
      skill: 'Air conditioner deep service and gas recharge',
      status: 'In progress',
      finish: '30 September 2026 19:45 IST',
      proofs: 12,
    };

    const empty = cellsOf(jobsTable([])).widths;
    const long = cellsOf(jobsTable([longRow, longRow, longRow])).widths;
    expect(long).toEqual(empty);
    expect(long).toEqual([38, '*', 80, 58, 72, 78, 34]);
  });

  it('stamps noWrap only on the two time headers so they never mid-word wrap', () => {
    const [header] = cellsOf(jobsTable([])).body;

    expect(header[4]).toHaveProperty('noWrap', true); // Planned time
    expect(header[5]).toHaveProperty('noWrap', true); // Finish time
    expect(header[0]).not.toHaveProperty('noWrap', true);
  });
});

describe('jobsTable — body rows', () => {
  it('zebra-stripes odd rows and leaves even rows unfilled', () => {
    const table = cellsOf(jobsTable([row, row, row]));

    expect(table.body[1][0].fillColor).toBeUndefined();
    expect(table.body[2][0].fillColor).toBe(TABLE.zebraBackground);
    expect(table.body[3][0].fillColor).toBeUndefined();
  });

  it('resolves the status cell colour and tint from the display label', () => {
    const table = cellsOf(jobsTable([row]));
    const statusCell = table.body[1][3];

    expect(statusCell.text).toBe('In progress');
    expect(statusCell.color).toBe(statusColors.in_progress);
    expect(statusCell.fillColor).toBe(statusTints.in_progress);
  });

  it('falls back to neutral text on the zebra fill for an unknown status label', () => {
    const table = cellsOf(jobsTable([{ ...row, status: 'Blocked' }]));
    const statusCell = table.body[1][3];

    expect(statusCell.color).toBe(brand.text);
    expect(statusCell.fillColor).toBeUndefined(); // even row → plain zebra absence
  });

  it('renders zero proofs as an em dash, real counts as the number', () => {
    const table = cellsOf(jobsTable([{ ...row, proofs: 0 }, { ...row, proofs: 3 }]));

    expect(table.body[1][6].text).toBe('—');
    expect(table.body[2][6].text).toBe('3');
  });

  it('keeps body text quiet (body colour, regular Inter font)', () => {
    const table = cellsOf(jobsTable([row]));

    expect(table.body[1][0]).toMatchObject({
      text: 'J-1042',
      color: brand.text, // job number stands out slightly
    });
    expect(table.body[1][1]).toMatchObject({
      text: 'Priya Sharma',
      color: brand.textBody,
      font: FONT_FAMILY,
    });
  });
});

describe('jobsTable — layout', () => {
  it('uses the single-stripe system: the only rule is under the header row', () => {
    const layout = (jobsTable([row]) as unknown as {
      layout: {
        hLineWidth(i: number): number;
        vLineWidth(i: number): number;
        hLineColor(i: number): string;
      };
    }).layout;

    expect(layout.hLineWidth(0)).toBe(0);
    expect(layout.hLineWidth(1)).toBe(TABLE.borderWidth);
    expect(layout.hLineWidth(2)).toBe(0);
    expect(layout.vLineWidth(0)).toBe(0);
    expect(layout.hLineColor(1)).toBe(brand.border);
  });
});