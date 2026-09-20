import {
  buildTechnicianJobActivityDocument,
} from './technician-job-activity.template';
import {
  FetchedJob,
  TechnicianJobActivityData,
} from './technician-job-activity.data';

/**
 * Template assembly test for the Technician Job Activity report (story 12-5).
 *
 * The brand-kit builders are pure, so they run real — EXCEPT the two asset
 * modules that read files at module load / icon render (brand-assets.ts reads
 * the logo PNG, brand-icons.ts reads Lucide SVGs). Both are mocked so the
 * test stays on assembly, with no filesystem access.
 */

jest.mock('../templates/brand-kit/brand-assets', () => ({
  logoDataUri: 'data:image/png;base64,MOCKLOGO',
  FONT_SEMIBOLD: 'Inter-SemiBold',
}));

jest.mock('../templates/brand-kit/brand-icons', () => ({
  iconNode: jest.fn(() => ({ svg: '<svg/>', width: 10, height: 10 })),
}));

const NOW = new Date('2026-09-20T10:00:00Z');

function job(overrides: Partial<FetchedJob> & { id: string }): FetchedJob {
  return {
    jobNumber: `J-${overrides.id}`,
    technicianId: 't1',
    customerId: 'c1',
    customerName: 'Customer',
    skillName: null,
    status: 'completed',
    priority: 'normal',
    scheduledStart: '2026-09-01T03:30:00Z',
    scheduledEnd: null,
    completedAt: null,
    photoCount: 0,
    signatureCount: 0,
    ...overrides,
  };
}

/** One technician with three jobs, one other with none (FR18). */
function fixtureData(): TechnicianJobActivityData {
  return {
    tenant: { companyName: 'Acme Services', address: '12 MG Road' },
    range: { startDate: '2026-09-01', endDate: '2026-09-07' },
    technicians: [
      { id: 't1', name: 'Ravi' },
      { id: 't2', name: 'Amit' },
    ],
    jobs: [
      // Completed on time with proofs; IST planned time = 1 Sep 09:00,
      // finish = 2 Sep 11:15.
      job({
        id: 'j1',
        skillName: 'Plumbing',
        scheduledEnd: '2026-09-01T06:00:00Z',
        completedAt: '2026-09-02T05:45:00Z',
        photoCount: 1,
        signatureCount: 1,
      }),
      // Open and overdue at the frozen NOW — a flag.
      job({ id: 'j2', status: 'in_progress' }),
      // Cancelled — an informational flag.
      job({ id: 'j3', status: 'cancelled' }),
    ],
  };
}

/** Depth-first walk over every pdfmake content node. */
function walk(node: unknown, visit: (o: Record<string, unknown>) => void) {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    visit(obj);
    for (const key of [
      'stack',
      'columns',
      'table',
      'body',
      'canvas',
      'rows',
      'content',
    ]) {
      if (key in obj) walk(obj[key], visit);
    }
  }
}

function collectTexts(node: unknown): string[] {
  const texts: string[] = [];
  walk(node, (o) => {
    if (typeof o.text === 'string') texts.push(o.text);
  });
  return texts;
}

/** The card stack containing `label` (label node + value node, per
 *  summary-cards.ts's cell stack) — the Overall cards appear before the
 *  per-technician ones, so the FIRST match is asserted. */
function cardValue(root: unknown, label: string): string {
  let value: string | undefined;
  walk(root, (o) => {
    if (value !== undefined || !Array.isArray(o.stack)) return;
    const stack = o.stack as Record<string, unknown>[];
    const idx = stack.findIndex((s) => s?.text === label);
    if (idx >= 0 && stack[idx + 1]) value = stack[idx + 1].text as string;
  });
  if (value === undefined) throw new Error(`card '${label}' not found`);
  return value;
}

/** Finds the pdfmake jobs table (headerRows: 1 is unique to jobsTable). */
function jobsTableBody(root: unknown): Record<string, unknown>[][] {
  let body: Record<string, unknown>[][] | undefined;
  walk(root, (o) => {
    const table = o.table as
      | { headerRows?: number; body?: unknown }
      | undefined;
    if (table && table.headerRows === 1 && !body) {
      body = table.body as Record<string, unknown>[][];
    }
  });
  if (!body) throw new Error('jobs table not found');
  return body;
}

describe('TechnicianJobActivityTemplate — buildTechnicianJobActivityDocument (story 12-5)', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('document skeleton (all from the brand kit)', () => {
    it('builds an A4 doc with brand margins, Inter defaults and a footer callback', () => {
      const doc = buildTechnicianJobActivityDocument(fixtureData()) as Record<
        string,
        unknown
      >;

      expect(doc.pageSize).toBe('A4');
      expect(doc.pageMargins).toEqual([40, 48, 40, 56]);
      expect(doc.defaultStyle).toEqual({
        font: 'Inter',
        fontSize: 9.5,
        color: '#374151',
      });
      expect(typeof doc.footer).toBe('function');

      // The footer callback renders page numbers + the privacy line, both on
      // the IST clock (frozen NOW → 15:30 IST).
      const footer = (doc.footer as (p: number, c: number) => unknown)(1, 3);
      const texts = collectTexts(footer);
      expect(texts).toContain('Fenzit · 1 / 3');
      expect(texts).toContain(
        'Created 2026-09-20 15:30 IST · Private — contains customer details',
      );
    });

    it('embeds the tenant identity, title, IST range and scope in the header', () => {
      const doc = buildTechnicianJobActivityDocument(
        fixtureData(),
      ) as Record<string, unknown>;
      const texts = collectTexts(doc.content);

      expect(texts).toContain('Technician Job Report');
      expect(texts).toContain('Acme Services');
      expect(texts).toContain('12 MG Road');
      expect(texts).toContain('2026-09-01 → 2026-09-07 (IST)');
      expect(texts).toContain('2 technicians selected · 3 jobs in this period');
    });
  });

  describe('empty dataset (FR18)', () => {
    it('renders the explicit empty-state block instead of any section', () => {
      const data = fixtureData();
      data.technicians = [];
      data.jobs = [];

      const doc = buildTechnicianJobActivityDocument(data) as Record<
        string,
        unknown
      >;
      const content = doc.content as Record<string, unknown>[];

      // Just the header, then the empty-state block — no Overall, no tables.
      expect(content).toHaveLength(2);
      const texts = collectTexts(content);
      expect(texts).toContain('All technicians · 0 jobs in this period');
      expect(texts).toContain('No jobs for these dates');
      expect(texts).not.toContain('Overall');
      expect(() => jobsTableBody(doc.content)).toThrow('jobs table not found');

      const emptyBlock = content[1] as {
        table: { body: [[{ text: string; fontSize: number }]] };
      };
      expect(emptyBlock.table.body[0][0].text).toBe('No jobs for these dates');
      expect(emptyBlock.table.body[0][0].fontSize).toBe(13);
    });
  });

  describe('populated dataset', () => {
    it('opens with the Overall section as two metric-card rows', () => {
      const doc = buildTechnicianJobActivityDocument(
        fixtureData(),
      ) as Record<string, unknown>;
      const texts = collectTexts(doc.content);

      for (const label of [
        'Total jobs',
        'Completed',
        'Open',
        'Cancelled',
        'Finished on time %',
        'Urgent jobs done',
        'Customers',
        'Photos & signatures',
      ]) {
        expect(texts).toContain(label);
      }

      // Exact values from the fixture's metric set.
      expect(cardValue(doc.content, 'Total jobs')).toBe('3');
      expect(cardValue(doc.content, 'Completed')).toBe('1');
      expect(cardValue(doc.content, 'Open')).toBe('1');
      expect(cardValue(doc.content, 'Cancelled')).toBe('1');
      // Finished after its planned end (1 Sep 06:00Z vs 2 Sep 05:45Z) → 0%.
      expect(cardValue(doc.content, 'Finished on time %')).toBe('0%');
      expect(cardValue(doc.content, 'Urgent jobs done')).toBe('0');
      expect(cardValue(doc.content, 'Customers')).toBe('1');
      expect(cardValue(doc.content, 'Photos & signatures')).toBe('2');

      // Real derived captions only.
      expect(texts).toContain('33% finish rate');
      expect(texts).toContain('33% drop rate');
    });

    it('keeps the Overall title glued to its first card row (unbreakable)', () => {
      const doc = buildTechnicianJobActivityDocument(
        fixtureData(),
      ) as Record<string, unknown>;

      const keptBlocks: Record<string, unknown>[] = [];
      walk(doc.content, (o) => {
        if (o.unbreakable === true) keptBlocks.push(o);
      });
      const overall = keptBlocks.find(
        (o) => (o.stack as Record<string, unknown>[])[0]?.text === 'Overall',
      );
      expect(overall).toBeDefined();
      // The glued first block is a summary-card row (columns of cards).
      expect(
        Array.isArray((overall!.stack[1] as Record<string, unknown>).columns),
      ).toBe(true);
    });

    it('renders one branded jobs table per technician with mapped rows', () => {
      const doc = buildTechnicianJobActivityDocument(fixtureData());

      const tables = [jobsTableBody(doc)];
      // Only Ravi has jobs; Amit's section uses the empty-state row.
      const body = tables[0];
      expect(body[0].map((c) => c.text)).toEqual([
        'JOB',
        'CUSTOMER',
        'SKILL',
        'STATUS',
        'PLANNED TIME',
        'FINISH TIME',
        'PROOFS',
      ]);

      const rowTexts = body.slice(1).map((row) => row.map((c) => c.text));
      expect(rowTexts).toEqual([
        // IST times: 03:30Z → 09:00 on 1 Sep; finish 05:45Z → 11:15 on 2 Sep.
        ['J-j1', 'Customer', 'Plumbing', 'Completed', '1 Sep 09:00', '2 Sep 11:15', '2'],
        // In-progress job: no finish time, no proofs — em-dashes.
        ['J-j2', 'Customer', '—', 'In progress', '1 Sep 09:00', '—', '—'],
        ['J-j3', 'Customer', '—', 'Cancelled', '1 Sep 09:00', '—', '—'],
      ]);
    });

    it('includes zero-job technicians with an empty-state row (FR18)', () => {
      const doc = buildTechnicianJobActivityDocument(fixtureData());
      const texts = collectTexts(doc.content);

      expect(texts).toContain('Ravi');
      expect(texts).toContain('Amit');
      // emptyStateRow (8.5) — the small in-section variant, not the 13pt block.
      const rowEmpty = { found: false, size: 0 };
      walk(doc.content, (o) => {
        if (o.text === 'No jobs for these dates' && o.fontSize === 8.5) {
          rowEmpty.found = true;
          rowEmpty.size = 8.5;
        }
      });
      expect(rowEmpty.found).toBe(true);
    });

    it('renders the Needs attention section with severity-sorted flag rows', () => {
      const doc = buildTechnicianJobActivityDocument(fixtureData());
      const texts = collectTexts(doc.content);

      expect(texts).toContain('Needs attention');

      // Flag rows: "<kind> · <jobNumber>" title, "<detail> — <technician>".
      expect(texts).toContain('Not done on time · J-j2');
      expect(texts).toContain(
        'Work has started, but the planned time has passed. — Ravi',
      );
      expect(texts).toContain('Cancelled · J-j3');
      expect(texts).toContain(
        'This job was cancelled. Please check if the customer needs help. — Ravi',
      );

      // Order inside the list is severity order (overdue before cancelled).
      const flagTitles = texts.filter((t) => t.includes(' · J-'));
      expect(flagTitles).toEqual(['Not done on time · J-j2', 'Cancelled · J-j3']);
    });

    it('omits the Needs attention section when nothing needs attention', () => {
      const data = fixtureData();
      // Everything completed on time with proof: no flags. scheduledStart in
      // 2020 keeps the open-status rule out of play for completed jobs anyway.
      data.jobs = [
        job({
          id: 'j1',
          scheduledEnd: '2026-09-01T06:00:00Z',
          completedAt: '2026-09-01T05:00:00Z',
          photoCount: 1,
          signatureCount: 1,
        }),
      ];

      const doc = buildTechnicianJobActivityDocument(data);
      expect(collectTexts(doc.content)).not.toContain('Needs attention');
    });
  });
});