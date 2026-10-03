import {
  buildAttendanceReportDocument,
} from './attendance.template';
import type { AttendanceReportData } from './attendance.data';
import type { AttendanceSummary } from './attendance.metrics';

/**
 * Template assembly test for the Attendance Report (story 21-3). Same
 * discipline as the job-report template spec: the brand-kit builders run
 * real except the two asset modules (logo PNG + icon SVGs), which are
 * mocked. Assertions pin the SECTION CONTRACT (spec report-content.md):
 * presence/suppression per scope, the register's ≤ 31-day gate, the
 * exceptions cap, and the zero states — never the incidental layout.
 */

jest.mock('../templates/brand-kit/brand-assets', () => ({
  logoDataUri: 'data:image/png;base64,MOCKLOGO',
  FONT_SEMIBOLD: 'Inter-SemiBold',
}));

jest.mock('../templates/brand-kit/brand-icons', () => ({
  iconNode: jest.fn(() => ({ svg: '<svg/>', width: 10, height: 10 })),
}));

const summary = (over: Partial<AttendanceSummary> = {}): AttendanceSummary => ({
  daysWorked: 2.5,
  halfDays: 0,
  lateCount: 1,
  leave: 1,
  weeklyOffs: 0,
  holidays: 0,
  workedOnHoliday: 0,
  absent: 3,
  checkoutMissing: 0,
  trackedDays: 6,
  fullDays: 2,
  lateMinutes: 45,
  earlyOuts: 0,
  workedMinutesTotal: 900,
  corrections: 1,
  fakeLocationDays: 1,
  pendingLeaveDays: 0,
  halfDayLeaves: 0,
  expectedDays: 5,
  attendanceRate: 50,
  workedHours: 15,
  avgHoursPerDay: 6,
  ...over,
});

function fixtureData(over: Partial<AttendanceReportData> = {}): AttendanceReportData {
  return {
    tenant: { companyName: 'Acme Services' },
    range: { startDate: '2026-09-01', endDate: '2026-09-25', days: 25 },
    scope: {
      allOffices: true,
      allEmployees: true,
      selectedOffices: 0,
      selectedEmployees: 0,
      employeesInScope: 2,
      registerDays: 25,
    },
    overall: summary(),
    offices: [
      {
        id: 'o1',
        name: 'HQ',
        employees: 2,
        summary: summary({ expectedDays: 5, attendanceRate: 60 }),
      },
    ],
    employees: [
      {
        id: 'e1',
        name: 'Asha',
        offices: 'HQ',
        enrolledFrom: null,
        summary: summary(),
      },
      {
        id: 'e2',
        name: 'Bimal',
        offices: 'HQ, Branch',
        enrolledFrom: '2026-09-10',
        summary: summary({ leave: 0, corrections: 0, fakeLocationDays: 0, lateCount: 0, lateMinutes: 0 }),
      },
    ],
    exceptions: [
      {
        kind: 'fake_location',
        severity: 'alarm',
        employeeName: 'Asha',
        title: 'Fake-location attempt',
        detail: '1 day with unacknowledged fake-location punches — 2026-09-10',
      },
    ],
    weeks: [
      { label: '1 Sep – 7 Sep', summary: summary({ attendanceRate: 40 }) },
      { label: '8 Sep – 14 Sep', summary: summary({ attendanceRate: 60 }) },
      { label: '15 Sep – 21 Sep', summary: summary({ attendanceRate: 55 }) },
      { label: '22 Sep – 25 Sep', summary: summary({ attendanceRate: 45 }) },
    ],
    register: {
      dates: Array.from({ length: 25 }, (_, i) =>
        new Date(Date.parse('2026-09-01') + i * 86_400_000).toISOString().slice(0, 10),
      ),
      rows: [
        { name: 'Asha', codes: Array.from({ length: 25 }, () => 'P') },
        { name: 'Bimal', codes: Array.from({ length: 25 }, () => 'A') },
      ],
    },
    rejections: [
      { employeeId: 'e1', employeeName: 'Asha', tooFar: 1, lowAccuracy: 0, mocked: 2, rateLimited: 0, other: 0 },
    ],
    ...over,
  };
}

/** Every text string in the assembled document tree. */
function allTexts(doc: ReportDocumentLike): string[] {
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
  walk((doc as { content: unknown }).content);
  return out;
}

type ReportDocumentLike = { content: unknown };

const has = (texts: string[], needle: string) =>
  texts.some((t) => t.includes(needle));

describe('buildAttendanceReportDocument (21-3)', () => {
  it('stays A4 portrait with the standard margins and footer', () => {
    const doc = buildAttendanceReportDocument(fixtureData());
    expect(doc.pageSize).toBe('A4');
    expect(Array.isArray(doc.pageMargins)).toBe(true);
    expect(doc.footer).toBeDefined();
  });

  it('renders the normative section order for a full scope', () => {
    const texts = allTexts(buildAttendanceReportDocument(fixtureData()));
    const order = ['Overall', 'Offices', 'Employees — attendance', 'Employees — discipline & hours', 'Needs attention', 'Weekly trend', 'Leave summary', 'Rejected punches'];
    const positions = order.map((section) =>
      texts.findIndex((t) => t === section),
    );
    positions.forEach((p, i) => expect(p).toBeGreaterThanOrEqual(0));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('overall cards carry the pre-aggregated numbers (no template math)', () => {
    const texts = allTexts(buildAttendanceReportDocument(fixtureData()));
    expect(has(texts, '50%')).toBe(true); // attendanceRate straight from the summary
    expect(has(texts, '15.0 h')).toBe(true); // workedHours
    expect(has(texts, 'Employees in scope')).toBe(true);
    expect(has(texts, 'Fake-location attempts')).toBe(true);
  });

  it('the joined annotation renders the real date, not a hard-coded one', () => {
    const texts = allTexts(buildAttendanceReportDocument(fixtureData()));
    expect(has(texts, 'from 10 Sep')).toBe(true);
    expect(has(texts, 'from 20 Sep')).toBe(false);
  });

  it('suppresses sections with nothing to show (leave, rejections, offices, exceptions)', () => {
    const doc = buildAttendanceReportDocument(
      fixtureData({
        offices: [],
        exceptions: [],
        rejections: [],
        employees: [
          {
            id: 'e1',
            name: 'Asha',
            offices: 'HQ',
            enrolledFrom: null,
            summary: summary({ leave: 0, pendingLeaveDays: 0, halfDayLeaves: 0 }),
          },
        ],
      }),
    );
    const texts = allTexts(doc);
    expect(has(texts, 'Leave summary')).toBe(false);
    expect(has(texts, 'Rejected punches')).toBe(false);
    expect(has(texts, 'Offices')).toBe(false);
    expect(has(texts, 'Needs attention')).toBe(false);
  });

  it('skips the weekly trend when the range is a single week', () => {
    const texts = allTexts(
      buildAttendanceReportDocument(
        fixtureData({ weeks: [fixtureData().weeks[0]] }),
      ),
    );
    expect(has(texts, 'Weekly trend')).toBe(false);
  });

  it('renders the day register with its legend for short ranges', () => {
    const texts = allTexts(buildAttendanceReportDocument(fixtureData()));
    expect(has(texts, 'P present · H half day · A absent')).toBe(true);
    expect(has(texts, 'Asha')).toBe(true);
  });

  it('drops the day register when the data says the range was long', () => {
    const texts = allTexts(
      buildAttendanceReportDocument(fixtureData({ register: null })),
    );
    expect(has(texts, 'P present · H half day · A absent')).toBe(false);
  });

  it('caps the exceptions list at 200 with a "+N more" line', () => {
    const many = Array.from({ length: 210 }, (_, i) => ({
      kind: 'repeat_late' as const,
      severity: 'warning' as const,
      employeeName: `Employee ${i}`,
      title: 'Repeatedly late',
      detail: `Late on 3 days — 2026-09-${String((i % 25) + 1).padStart(2, '0')}`,
    }));
    const texts = allTexts(buildAttendanceReportDocument(fixtureData({ exceptions: many })));
    expect(has(texts, '+10 more — narrow the filters')).toBe(true);
    // The cap: only the first 200 render.
    expect(has(texts, 'Employee 199')).toBe(true);
    expect(has(texts, 'Employee 200')).toBe(false);
  });

  it('renders the honest empty page when nobody was in scope', () => {
    const texts = allTexts(
      buildAttendanceReportDocument(
        fixtureData({
          employees: [],
          offices: [],
          exceptions: [],
          rejections: [],
          weeks: [],
          register: null,
          scope: {
            allOffices: true,
            allEmployees: true,
            selectedOffices: 0,
            selectedEmployees: 0,
            employeesInScope: 0,
            registerDays: null,
          },
        }),
      ),
    );
    expect(has(texts, 'No attendance data for these dates')).toBe(true);
    expect(has(texts, 'Overall')).toBe(false);
  });
});
