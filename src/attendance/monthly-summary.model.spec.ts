import type { DayContext } from './day-context';
import type { DayGridRow, RecordRow, OverrideRow } from './day-status.read';
import { summariseEmployeeMonth } from './monthly-summary.model';
import type { MonthlyEmployeeSummary } from './monthly-summary.model';

/**
 * Pure spec for 19-3's monthly aggregation. Written as a tester: the tiles
 * must count the REQUIREMENT, not the implementation's happy path — empty
 * sets, untracked rows (rule 2), sibling statuses that must NOT inflate
 * half-day/off-day counts, and the float-snap on the wire values.
 *
 * Fixture rule: 09:30-18:30 (570/1110), cutoff 15, full day hours 8
 * (= 480 minutes), half day hours 4 (= 240). Instants in tenant wall time
 * (+05:30 == the fixture tz), past rows only (rule 6/8/9's past gating).
 */

const TODAY = '2026-09-29';
const PAST = '2026-09-28';
const TENANT = '00000000-0000-4000-8000-000000000001';
const EMP = '00000000-0000-4000-8000-000000000002';

/* The grid rows' record/override shapes — the real interfaces exported by
   day-status.read.ts (no structural mirrors to drift from). */

const record = (
  checkin: string | null,
  checkout: string | null,
): RecordRow => ({
  employee_id: EMP,
  work_date: PAST,
  checkin_at: checkin ? new Date(`${PAST}T${checkin}:00+05:30`) : null,
  checkout_at: checkout ? new Date(`${PAST}T${checkout}:00+05:30`) : null,
});

const override = (fields: Partial<OverrideRow> = {}): OverrideRow => ({
  employee_id: EMP,
  work_date: PAST,
  status: null,
  manual_checkin_at: null,
  manual_checkout_at: null,
  ...fields,
});

const ctx = (over: Partial<DayContext> = {}): DayContext => ({
  tenantId: TENANT,
  employeeId: EMP,
  workDate: PAST,
  timezone: 'Asia/Kolkata',
  trackedBase: true,
  tracked: true,
  enableDayGraceBlocks: false,
  officeId: 'office-1',
  officeName: 'HQ',
  officeLat: 12.97,
  officeLng: 77.59,
  radiusM: 100,
  officeRulesId: 'rule-1',
  startMinute: 570,
  endMinute: 1110,
  midpointMinute: 840,
  lateCutoffMinutes: 15,
  fullDayMinutes: 480,
  halfDayMinutes: 240,
  isWeeklyOff: false,
  holidayId: null,
  holidayName: null,
  isWorkingDay: true,
  leaveState: null,
  leavePart: null,
  leaveRequestId: null,
  ...over,
});

type RowOver = {
  ctx?: Partial<DayContext>;
  record?: RecordRow | null;
  override?: OverrideRow | null;
  tracked?: boolean;
};

const row = (over: RowOver = {}): DayGridRow => {
  // Fixture honesty pin: on a real grid row, the record and override ARE
  // ctx.workDate's facts — their work_date can never disagree with the
  // covering row's date (the engine's rule 2/6/8/9 past-gate reads
  // ctx.workDate; a stale fixture work_date would let a future
  // work-date-reading drift test pass against fixtures no real read
  // produces). Stamp the fixtures from the SAME derived date here.
  const workDate = over.ctx?.workDate ?? PAST;
  return {
    employeeId: EMP,
    workDate,
    today: TODAY,
    ctx: ctx({
      ...over.ctx,
      ...(over.tracked === false ? { tracked: false } : {}),
    }),
    record: over.record ? { ...over.record, work_date: workDate } : null,
    override: over.override
      ? { ...over.override, work_date: workDate }
      : null,
    hasUnackMockedAttempt: false,
    latestCorrection: null,
  };
};

const EMPTY: MonthlyEmployeeSummary = {
  daysWorked: 0,
  halfDays: 0,
  lateCount: 0,
  leave: 0,
  weeklyOffs: 0,
  holidays: 0,
  workedOnHoliday: 0,
  absent: 0,
  checkoutMissing: 0,
};

const like = (over: Partial<MonthlyEmployeeSummary>): MonthlyEmployeeSummary =>
  ({ ...EMPTY, ...over });

describe('summariseEmployeeMonth (19-3, FR-11 parity)', () => {
  it('empty input is an all-zero summary — never NaN, never null', () => {
    expect(summariseEmployeeMonth([])).toEqual(EMPTY);
  });

  it('skips untracked rows entirely (rule-2 days count nowhere)', () => {
    expect(summariseEmployeeMonth([row({ tracked: false })])).toEqual(EMPTY);
  });

  it('a full record grades present: daysWorked 1, no tile noise', () => {
    const summary = summariseEmployeeMonth([
      row({ record: record('09:30', '18:30') }),
    ]);
    // 540 minutes of 480 → full day; 09:30 is within the 15-min grace →
    // no Late flag.
    expect(summary).toEqual(like({ daysWorked: 1 }));
  });

  it('a short record grades half_day — SIBLING statuses are excluded', () => {
    const summary = summariseEmployeeMonth([
      row({ record: record('09:30', '14:30') }), // 300 min ≥ 240 → half_day
      row({
        ctx: {
          workDate: '2026-09-27',
          leaveState: 'approved',
          leavePart: 'first_half',
        },
        record: record('09:30', '14:30'),
      }), // half_day_leave: earns 0.5 worked + 0.5 leave, NOT a half_day tile
    ]);
    // Both check-ins sit within the 15-min grace → no Late flag on either.
    expect(summary).toEqual(
      like({ daysWorked: 1, halfDays: 1, leave: 0.5, lateCount: 0 }),
    );
  });

  it('lateCount flags only days whose engine outcome isLate (grace honoured)', () => {
    const summary = summariseEmployeeMonth([
      row({ record: record('09:41', '18:30') }), // inside the 09:45 grace → not late
      row({
        ctx: { workDate: '2026-09-26' },
        record: record('09:50', '18:30'),
      }), // 5 min past the grace floor → late
    ]);
    expect(summary.lateCount).toBe(1);
    expect(summary.daysWorked).toBe(2);
  });

  it('leave sums leaveCredit — approved full 1, and PENDING earns nothing', () => {
    const summary = summariseEmployeeMonth([
      row({
        ctx: {
          workDate: '2026-09-25',
          leaveState: 'approved',
          leavePart: 'full_day',
        },
      }),
      row({
        ctx: {
          workDate: '2026-09-24',
          leaveState: 'pending',
          leavePart: 'full_day',
        },
      }),
    ]);
    expect(summary.leave).toBe(1);
    expect(summary.daysWorked).toBe(0);
  });

  it('counts off-day tiles by grading — worked off-days credit workOnHoliday instead', () => {
    const summary = summariseEmployeeMonth([
      row({
        ctx: { workDate: '2026-09-27', isWeeklyOff: true, isWorkingDay: false },
      }), // weekly_off
      row({
        ctx: {
          workDate: '2026-09-26',
          holidayId: 'h1',
          holidayName: 'D',
          isWorkingDay: false,
        },
      }), // holiday (labelled, no work)
      row({
        ctx: {
          workDate: '2026-09-25',
          holidayId: 'h2',
          holidayName: 'E',
          isWorkingDay: false,
        },
        record: record('09:30', '18:30'),
      }), // worked_on_holiday: not a holidays tile, credits 1
    ]);
    expect(summary).toEqual(like({ weeklyOffs: 1, holidays: 1, workedOnHoliday: 1 }));
  });

  it('absent counts only rule-9 graded rows — not untracked, not off-days', () => {
    const summary = summariseEmployeeMonth([
      row({}), // past tracked working day, nothing → absent
      row({ tracked: false }), // pre-enrolment → never a tile
      row({
        ctx: { workDate: '2026-09-27', isWeeklyOff: true, isWorkingDay: false },
      }), // weekly_off, not absent
    ]);
    expect(summary).toEqual(like({ absent: 1, weeklyOffs: 1 }));
  });

  it('checkoutMissing counts the MARKER in any grading (incl. a corrected day)', () => {
    const summary = summariseEmployeeMonth([
      row({ record: record('09:30', null) }), // rule 8's past gate → marker
      row({
        ctx: {
          workDate: '2026-09-26',
          holidayId: 'h1',
          holidayName: 'D',
          isWorkingDay: false,
        },
        record: record('10:00', null),
      }), // worked_on_holiday, open → still flags
      row({
        ctx: { workDate: '2026-09-25' },
        override: override({ status: 'absent' }), // adjudicated → no marker
        record: record('09:30', null),
      }),
    ]);
    // The off-day marker carries lateMinutes null (no Late on off-day
    // statuses), and the adjudicated day still grades its absent tile.
    expect(summary).toEqual(like({ checkoutMissing: 2, absent: 1 }));
  });

  it('credit steps never drift — threshold grading produces {0, 0.5, 1} steps', () => {
    // 09:30-17:15 = 465 min sits BETWEEN the half (240) and full (480)
    // thresholds → half_day: the grading is threshold-based, so a summary
    // of four 465-minute days reads exactly 2.0 — never 3.875.
    const summary = summariseEmployeeMonth([
      row({ record: record('09:30', '17:15') }),
      row({ ctx: { workDate: '2026-09-26' }, record: record('09:30', '17:15') }),
      row({ ctx: { workDate: '2026-09-25' }, record: record('09:30', '17:15') }),
      row({ ctx: { workDate: '2026-09-24' }, record: record('09:30', '17:15') }),
    ]);
    expect(summary.daysWorked).toBe(2);
    expect(summary.halfDays).toBe(4);
    // Three approved halves sum to exactly 1.5 leaves.
    const leave = summariseEmployeeMonth([
      row({ ctx: { workDate: '2026-09-24', leaveState: 'approved', leavePart: 'first_half' } }),
      row({ ctx: { workDate: '2026-09-23', leaveState: 'approved', leavePart: 'second_half' } }),
      row({ ctx: { workDate: '2026-09-22', leaveState: 'approved', leavePart: 'first_half' } }),
    ]);
    expect(leave.leave).toBe(1.5);
  });
});
