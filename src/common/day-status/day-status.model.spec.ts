import { computeDayStatus, effectiveInstants, type EngineOverrideRow, type EngineRecordRow } from './day-status.model';
import type { DayContext } from './day-context';
import type { DayStatusOutcome } from './day-status.model';

/**
 * Pure spec for the FR-10 engine (18-1). Written as a tester: every case
 * names the requirement behaviour it protects — the first-match-wins
 * ladder, the credit graders (FR-11), the outranked-leave / not_tracked
 * interplay rules, and the marker arms. A change to the implementation
 * (not the requirement) must not turn these red.
 *
 * Fixture rule: 09:30-18:30 (570/1110) for the late/early metrics, with
 * the G2-D1 grading thresholds as the owner sets them — full day hours 8
 * (= 480 minutes), half day hours 4 (= 240), late cutoff 15 (late floor
 * 09:45 in tenant time).
 */

const TZ = 'Asia/Kolkata';
const TODAY = '2026-09-29';
const PAST = '2026-09-28';
const FUTURE = '2026-09-30';
const TENANT = '00000000-0000-4000-8000-000000000001';
const EMP = '00000000-0000-4000-8000-000000000002';

const ctx = (over: Partial<DayContext> = {}): DayContext => ({
  tenantId: TENANT,
  employeeId: EMP,
  workDate: PAST,
  timezone: TZ,
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

/** Instants written in tenant wall time (+05:30 == the fixture tz). */
const rec = (checkin: string, checkout: string | null): EngineRecordRow => ({
  checkin_at: new Date(`2026-09-28T${checkin}:00+05:30`),
  checkout_at: checkout ? new Date(`2026-09-28T${checkout}:00+05:30`) : null,
});

const ov = (status: string | null, checkin: string | null, checkout: string | null = null): EngineOverrideRow => ({
  status,
  manual_checkin_at: checkin ? new Date(`2026-09-28T${checkin}:00+05:30`) : null,
  manual_checkout_at: checkout ? new Date(`2026-09-28T${checkout}:00+05:30`) : null,
});

const input = (over: {
  ctx?: Partial<DayContext>;
  record?: EngineRecordRow | null;
  override?: EngineOverrideRow | null;
  hasUnackMockedAttempt?: boolean;
  today?: string;
}) => ({
  ctx: ctx(over.ctx ?? {}),
  record: over.record ?? null,
  override: over.override ?? null,
  hasUnackMockedAttempt: over.hasUnackMockedAttempt ?? false,
  today: over.today ?? TODAY,
});

/** The credit/grade summary the assertions name. */
const gradeOf = (o: DayStatusOutcome) => ({
  status: o.status,
  daysWorked: o.daysWorked,
  leaveCredit: o.leaveCredit,
  workedOnHolidayCredit: o.workedOnHolidayCredit,
  markers: o.markers,
});

// ---- Rule 1: an active status-only correction wins -------------------------
describe('rule 1 — status-only override short-circuits', () => {
  it('present: grade 1 full day regardless of the record underneath', () => {
    const out = computeDayStatus(
      input({ record: rec('09:50', '18:40'), override: ov('present', null) }),
    );
    expect(gradeOf(out)).toEqual({
      status: 'present', daysWorked: 1, leaveCredit: 0,
      workedOnHolidayCredit: 0, markers: ['corrected'],
    });
  });

  it('half_day and absent grade 0.5 / 0 — the status fixes the credit', () => {
    expect(
      computeDayStatus(input({ record: rec('09:25', '18:40'), override: ov('half_day', null) })).daysWorked,
    ).toBe(0.5);
    expect(
      computeDayStatus(input({ record: rec('09:25', '18:40'), override: ov('absent', null) })).daysWorked,
    ).toBe(0);
  });

  it('metrics come from the EFFECTIVE instants (a corrected late check-in is still late)', () => {
    const out = computeDayStatus(
      input({ record: rec('09:50', '18:40'), override: ov('present', null) }),
    );
    expect(out.workedMinutes).toBe(530);
    expect(out.lateMinutes).toBe(5);
    expect(out.isLate).toBe(true);
  });

  it('outranked approved leave keeps its day rows as data but earns NO credits', () => {
    const out = computeDayStatus(
      input({
        record: rec('09:25', '18:40'),
        override: ov('absent', null),
        ctx: { leaveState: 'approved', leavePart: 'full_day' },
      }),
    );
    expect(out.status).toBe('absent');
    expect(out.leaveCredit).toBe(0);
    expect(out.markers).toEqual(['corrected']);
  });

  it('a present status arm over APPROVED full-day leave earns zero leave credits too (review G2-P11a)', () => {
    // The owner corrected the day to present — the day is worked, not
    // leave; the leave day-rows ride as data but no credit may pass.
    const out = computeDayStatus(
      input({
        record: null,
        override: ov('present', null),
        ctx: { leaveState: 'approved', leavePart: 'full_day' },
      }),
    );
    expect(gradeOf(out)).toEqual({
      status: 'present', daysWorked: 1, leaveCredit: 0,
      workedOnHolidayCredit: 0, markers: ['corrected'],
    });
  });

  it('beats the not_tracked ladder — a corrected untracked date still shows its status (history arm)', () => {
    const out = computeDayStatus(
      input({
        record: rec('11:00', '17:00'),
        override: ov('present', null),
        ctx: { tracked: false, trackedBase: false },
      }),
    );
    expect(out.status).toBe('present');
    expect(out.daysWorked).toBe(1);
  });

  it('accepts an override even on an untracked base date (the seeded-history write window)', () => {
    // Rule 2's not_tracked loses only to rule 1 — proven by construction
    // via the previous case; this pins the same for a bare (recordless) day.
    const out = computeDayStatus(
      input({
        record: rec('11:00', '12:00'),
        override: ov('present', null),
        ctx: { tracked: false },
      }),
    );
    expect(out.status).toBe('present');
  });
});

// ---- Rule 2: not tracked ------------------------------------------------------
describe('rule 2 — not tracked (loses only to rule 1)', () => {
  it('an untracked date with a stored record still shows not_tracked — the record rides as data', () => {
    const out = computeDayStatus(
      input({ record: rec('09:25', '18:40'), ctx: { tracked: false, trackedBase: false } }),
    );
    expect(gradeOf(out)).toEqual({
      status: 'not_tracked', daysWorked: 0, leaveCredit: 0,
      workedOnHolidayCredit: 0, markers: [],
    });
    expect(out.workedMinutes).toBe(555); // history the owner may still review
    expect(out.lateMinutes).toBeNull();
  });

  it('an untracked date with an outstanding correction cannot win back credits', () => {
    // Rule 2 beats a record AND an unpaid worked day; a status-only
    // override is the ONLY ladder step above it.
    const out = computeDayStatus(
      input({
        record: null,
        ctx: { tracked: false },
        override: ov(null, '11:00', '17:00'),
      }),
    );
    expect(out.status).toBe('not_tracked');
    expect(out.daysWorked).toBe(0);
  });
});

// ---- Rule 3: worked on a weekly off / holiday --------------------------------
describe('rule 3 — worked_on_holiday (credit separate, Late/Early suppressed)', () => {
  it('a full-shift check-in on a weekly off earns the holiday credit, never mixed into daysWorked', () => {
    const out = computeDayStatus(
      input({ record: rec('09:25', '18:40'), ctx: { isWeeklyOff: true, isWorkingDay: false } }),
    );
    expect(gradeOf(out)).toEqual({
      status: 'worked_on_holiday', daysWorked: 0, leaveCredit: 0,
      workedOnHolidayCredit: 1, markers: [],
    });
  });

  it('a half shift earns 0.5 and a short shift earns 0 — the same thresholds as GR-3', () => {
    const half = computeDayStatus(input({ record: rec('09:30', '15:00'), ctx: { isWeeklyOff: true } }));
    const short = computeDayStatus(input({ record: rec('09:30', '12:00'), ctx: { isWeeklyOff: true } }));
    expect(half.workedOnHolidayCredit).toBe(0.5);
    expect(short.workedOnHolidayCredit).toBe(0);
  });

  it('a HOLIDAY check-in grades the same way (weekly off is not special to the credit)', () => {
    const out = computeDayStatus(
      input({ record: rec('09:25', '18:40'), ctx: { holidayId: 'h-1', holidayName: 'Diwali', isWorkingDay: false } }),
    );
    expect(out.status).toBe('worked_on_holiday');
    expect(out.workedOnHolidayCredit).toBe(1);
  });

  it('an open past check-in carries the checkout_missing marker and zero credit', () => {
    const out = computeDayStatus(
      input({ record: rec('09:25', null), ctx: { isWeeklyOff: true, isWorkingDay: false } }),
    );
    expect(out.status).toBe('worked_on_holiday');
    expect(out.workedOnHolidayCredit).toBe(0); // open → 0
    expect(out.markers).toEqual(['checkout_missing']);
  });

  it('no Late/Early flag on an off-day check-in even when it is inside the cutoff window', () => {
    // 09:50 is 5 minutes past the late floor — the flag is suppressed by rule.
    const out = computeDayStatus(
      input({ record: rec('09:50', '18:40'), ctx: { isWeeklyOff: true, isWorkingDay: false } }),
    );
    expect(out.lateMinutes).toBeNull();
    expect(out.isLate).toBe(false);
  });

  it('today\'s open check-in on a holiday stays worked_on_holiday (rule 3 outranks rule 10)', () => {
    const out = computeDayStatus(
      input({
        record: rec('09:25', null),
        ctx: { isWeeklyOff: true, isWorkingDay: false, workDate: TODAY },
        today: TODAY, // workDate == today → isPast false
      }),
    );
    expect(out.status).toBe('worked_on_holiday');
    expect(out.markers).not.toContain('checkout_missing'); // isPast false
  });

  it('pending leave behind rule 3 shows only its marker and earns no credits', () => {
    const out = computeDayStatus(
      input({
        record: rec('09:25', '18:40'),
        ctx: { isWeeklyOff: true, leaveState: 'pending', leavePart: 'full_day', isWorkingDay: false },
      }),
    );
    expect(out.status).toBe('worked_on_holiday');
    expect(out.leaveCredit).toBe(0);
    expect(out.markers).toContain('leave_pending');
  });
});

// ---- Rule 4: weekly off, else holiday (no check-in) --------------------------
describe('rule 4 — weekly_off vs holiday label', () => {
  it('a weekly off with no check-in reads weekly_off', () => {
    expect(computeDayStatus(input({ ctx: { isWeeklyOff: true, isWorkingDay: false } })).status).toBe('weekly_off');
  });

  it('a holiday with no check-in reads holiday', () => {
    expect(
      computeDayStatus(input({ ctx: { holidayId: 'h-1', holidayName: 'Diwali', isWorkingDay: false } })).status,
    ).toBe('holiday');
  });

  it('a date that is BOTH weekly off and holiday reads weekly_off — the ladder\'s literal order (D1 ruling)', () => {
    const out = computeDayStatus(
      input({
        ctx: { isWeeklyOff: true, holidayId: 'h-1', holidayName: 'Diwali', isWorkingDay: false },
      }),
    );
    expect(out.status).toBe('weekly_off');
    expect(out.daysWorked).toBe(0);
  });

  it('a weekly-off day with a stored (recordless) times-only override still reads weekly_off', () => {
    // Rule 3 requires a check-in; a checkout-only correction cannot turn an
    // off-day into worked_on_holiday — the label survives, credits zero.
    const out = computeDayStatus(
      input({
        ctx: { isWeeklyOff: true, isWorkingDay: false },
        override: ov(null, null, '17:00'),
      }),
    );
    expect(out.status).toBe('weekly_off');
    expect(out.markers).toEqual(['corrected']);
  });
});

// ---- Rule 5: approved full-day leave ------------------------------------------
describe('rule 5 — full-day leave (no check-in)', () => {
  it('an approved full-day leave with no check-in earns one leave credit', () => {
    const out = computeDayStatus(
      input({ ctx: { leaveState: 'approved', leavePart: 'full_day' } }),
    );
    expect(gradeOf(out)).toEqual({
      status: 'leave', daysWorked: 0, leaveCredit: 1,
      workedOnHolidayCredit: 0, markers: [],
    });
  });

  it('a PENDING full-day leave does NOT block a stored worked day — rule 7 grades it, marker rides', () => {
    const out = computeDayStatus(
      input({
        record: rec('09:25', '18:40'),
        ctx: { leaveState: 'pending', leavePart: 'full_day' },
      }),
    );
    expect(out.status).toBe('present');
    expect(out.daysWorked).toBe(1);
    expect(out.markers).toEqual(['leave_pending']);
  });

  it('a pending full-day leave with no activity on a past date reads absent, marker only', () => {
    const out = computeDayStatus(input({ ctx: { leaveState: 'pending', leavePart: 'full_day' } }));
    expect(out.status).toBe('absent');
    expect(out.leaveCredit).toBe(0);
    expect(out.markers).toEqual(['leave_pending']);
  });
});

// ---- Rule 6: approved half-day leave -------------------------------------------
describe('rule 6 — half_day_leave credit', () => {
  it('leave day + a completed half shift: 0.5 leave credit + 0.5 worked credit', () => {
    const out = computeDayStatus(
      input({
        record: rec('09:30', '15:00'), // 330 min ≥ 270
        ctx: { leaveState: 'approved', leavePart: 'first_half' },
      }),
    );
    expect(gradeOf(out)).toEqual({
      status: 'half_day_leave', daysWorked: 0.5, leaveCredit: 0.5,
      workedOnHolidayCredit: 0, markers: [],
    });
    expect(out.workedMinutes).toBe(330);
  });

  it('leave day + a short-but-finished shift: the leave credit stands, the worked credit does not', () => {
    const out = computeDayStatus(
      input({
        record: rec('09:30', '12:00'), // 150 < 270
        ctx: { leaveState: 'approved', leavePart: 'first_half' },
      }),
    );
    expect(out.daysWorked).toBe(0);
    expect(out.leaveCredit).toBe(0.5);
  });

  it('an open record on the leave day TODAY defers to rule 10 (open by midnight unknowable)', () => {
    const out = computeDayStatus(
      input({
        record: rec('09:30', null),
        ctx: { leaveState: 'approved', leavePart: 'first_half' },
        today: PAST, // workDate == today
      }),
    );
    expect(out.status).toBe('in_progress');
    expect(out.markers).toEqual([]); // approved leave → no pending marker; isPast false
  });

  it('an open record on a PAST leave day earns nothing extra and flags checkout_missing', () => {
    const out = computeDayStatus(
      input({ record: rec('09:30', null), ctx: { leaveState: 'approved', leavePart: 'first_half' } }),
    );
    expect(out.status).toBe('half_day_leave');
    expect(out.daysWorked).toBe(0);
    expect(out.leaveCredit).toBe(0.5);
    expect(out.markers).toEqual(['checkout_missing']);
  });

  it('today\'s OPEN-AND-CLOSED record still grades through rule 6 (the deferral is open-only, not all today)', () => {
    const out = computeDayStatus(
      input({
        record: rec('09:30', '15:00'),
        ctx: { leaveState: 'approved', leavePart: 'first_half' },
        today: PAST,
      }),
    );
    expect(out.status).toBe('half_day_leave');
    expect(out.daysWorked).toBe(0.5);
  });
});

// ---- Rule 7: check-in with check-out, graded ---------------------------------
describe('rule 7 — the worked-day grade (GR-3 thresholds)', () => {
  it('a full shift reads present / 1.0 and carries the late/early facts', () => {
    const out = computeDayStatus(input({ record: rec('09:25', '18:40') }));
    expect(gradeOf(out)).toEqual({
      status: 'present', daysWorked: 1, leaveCredit: 0,
      workedOnHolidayCredit: 0, markers: [],
    });
    expect(out.workedMinutes).toBe(555);
    expect(out.lateMinutes).toBe(0);
    expect(out.isLate).toBe(false);
    // 18:40 is past the 18:30 rule end — no early flag at all.
    expect(out.earlyCheckoutMinutes).toBeNull();
    expect(out.earlyCheckout).toBe(false);
  });

  it('exactly-full boundary is present; exactly-half boundary is half_day — the >= semantics', () => {
    // 480 worked = the 8-hour full-day setting: 09:30...17:30 exactly.
    expect(computeDayStatus(input({ record: rec('09:30', '17:30') })).status).toBe('present');
    // 240 worked = the 4-hour half-day setting: 09:30...13:30.
    const half = computeDayStatus(input({ record: rec('09:30', '13:30') }));
    expect(half.status).toBe('half_day');
    expect(half.daysWorked).toBe(0.5);
    expect(half.earlyCheckoutMinutes).toBe(300);
    expect(half.earlyCheckout).toBe(true);
  });

  it('one minute below the half threshold is absent / 0', () => {
    // 239 worked: 09:30...13:29.
    const out = computeDayStatus(input({ record: rec('09:30', '13:29') }));
    expect(out.status).toBe('absent');
    expect(out.daysWorked).toBe(0);
    expect(out.workedMinutes).toBe(239);
    expect(out.earlyCheckoutMinutes).toBe(301);
  });

  it('a late check-in crosses the cutoff and shows only the minutes past it', () => {
    const out = computeDayStatus(input({ record: rec('09:50', '18:40') }));
    expect(out.lateMinutes).toBe(5);
    expect(out.isLate).toBe(true);
  });

  it('a leave-outranked worked day earns zero leave credits; the pending marker still rides', () => {
    const out = computeDayStatus(
      input({
        record: rec('09:25', '18:40'),
        ctx: { leaveState: 'approved', leavePart: 'full_day' },
      }),
    );
    // Rule 7 wins because a check-in exists; the approved leave stays data.
    expect(out.status).toBe('present');
    expect(out.leaveCredit).toBe(0);
    expect(out.markers).toEqual([]);
  });

  it('no covering rule → permissive grading (worked minutes present reads present) — D2 ruling behaviour', () => {
    const out = computeDayStatus(
      input({
        record: rec('10:00', '11:00'),
        ctx: { officeRulesId: null, startMinute: null, endMinute: null, midpointMinute: null, lateCutoffMinutes: null, fullDayMinutes: null, halfDayMinutes: null },
      }),
    );
    expect(out.status).toBe('present');
    expect(out.workedMinutes).toBe(60);
    expect(out.daysWorked).toBe(1);
    expect(out.lateMinutes).toBeNull(); // no rule → no late math
  });

  it('a RECORDLESS day corrected with a times-only override grades straight through rule 7 (review G2-P11e)', () => {
    // The owner wrote corrected instants on a day with no record at all —
    // the effective instants are the override's, and the day grades present
    // with the same thresholds as any checked-in day.
    const out = computeDayStatus(
      input({ record: null, override: ov(null, '09:25', '18:40') }),
    );
    expect(gradeOf(out)).toEqual({
      status: 'present', daysWorked: 1, leaveCredit: 0,
      workedOnHolidayCredit: 0, markers: ['corrected'],
    });
    expect(out.workedMinutes).toBe(555);
    expect(out.checkinSource).toBe('manual');
  });

  it('no covering rule with a positive worked shift on a holiday credits it fully (GR-3 no-rule arm)', () => {
    const out = computeDayStatus(
      input({
        record: rec('10:00', '11:00'),
        ctx: {
          isWeeklyOff: true,
          isWorkingDay: false,
          officeRulesId: null,
          startMinute: null,
          endMinute: null,
          midpointMinute: null,
          lateCutoffMinutes: null,
          fullDayMinutes: null,
          halfDayMinutes: null,
        },
      }),
    );
    expect(out.status).toBe('worked_on_holiday');
    expect(out.workedOnHolidayCredit).toBe(1);
  });
});

// ---- Rule 8: past, open record -----------------------------------------------
describe('rule 8 — past date with an open record', () => {
  it('reads checkout_missing, credits nothing, keeps the late facts', () => {
    const out = computeDayStatus(input({ record: rec('09:50', null) }));
    expect(gradeOf(out)).toEqual({
      status: 'checkout_missing', daysWorked: 0, leaveCredit: 0,
      workedOnHolidayCredit: 0, markers: ['checkout_missing'],
    });
    expect(out.workedMinutes).toBeNull();
    expect(out.lateMinutes).toBe(5);
    expect(out.earlyCheckoutMinutes).toBeNull();
  });

  it('an open record on a pending-leave day keeps BOTH markers (the pending marker rides every status)', () => {
    const out = computeDayStatus(
      input({
        record: rec('09:50', null),
        ctx: { leaveState: 'pending', leavePart: 'first_half' },
      }),
    );
    expect(out.markers).toEqual(['leave_pending', 'checkout_missing']);
  });
});

// ---- Rule 9: past, no check-in, no approved full leave ------------------------
describe('rule 9 — absent (past, no activity)', () => {
  it('a past date with nothing stored reads absent / 0', () => {
    const out = computeDayStatus(input({}));
    expect(gradeOf(out)).toEqual({
      status: 'absent', daysWorked: 0, leaveCredit: 0,
      workedOnHolidayCredit: 0, markers: [],
    });
  });

  it('a pending first-half leave on a past no-show shows the marker but stays absent', () => {
    const out = computeDayStatus(
      input({ ctx: { leaveState: 'pending', leavePart: 'second_half' } }),
    );
    expect(out.status).toBe('absent');
    expect(out.leaveCredit).toBe(0);
    expect(out.markers).toEqual(['leave_pending']);
  });
});

// ---- Rule 10: today / future ---------------------------------------------------
describe('rule 10 — today and future (before the day is closed)', () => {
  it('a today date with no stored record reads not_checked_in_yet', () => {
    const out = computeDayStatus(
      input({ ctx: { workDate: TODAY }, today: TODAY }),
    );
    expect(out.status).toBe('not_checked_in_yet');
    expect(out.daysWorked).toBe(0);
  });

  it('a today date with an open record reads in_progress (not checkout_missing)', () => {
    const out = computeDayStatus(
      input({ ctx: { workDate: TODAY }, today: TODAY, record: rec('09:50', null) }),
    );
    expect(out.status).toBe('in_progress');
    expect(out.lateMinutes).toBe(5); // the flag is live from the same math
    expect(out.markers).toEqual([]); // isPast false → no marker yet
  });

  it('a FUTURE date always reads not_checked_in_yet, never absent', () => {
    const out = computeDayStatus(
      input({ ctx: { workDate: FUTURE }, today: TODAY }),
    );
    expect(out.status).toBe('not_checked_in_yet');
  });
});

// ---- Markers --------------------------------------------------------------------
describe('markers — corrected, fake_location_attempt, combinations', () => {
  it('the AD-10 unacknowledged mocked attempt marker rides every status', () => {
    expect(
      computeDayStatus(input({ hasUnackMockedAttempt: true })).markers,
    ).toEqual(['fake_location_attempt']);
  });

  it('an override plus a mocked attempt carries BOTH markers in order', () => {
    const out = computeDayStatus(
      input({ record: rec('09:25', '18:40'), override: ov('present', null), hasUnackMockedAttempt: true }),
    );
    expect(out.status).toBe('present');
    expect(out.markers).toEqual(['fake_location_attempt', 'corrected']);
  });

  it('a corrected open past record carries corrected + checkout_missing', () => {
    const out = computeDayStatus(
      input({ record: rec('09:50', null), override: ov(null, '09:45') }),
    );
    expect(out.status).toBe('checkout_missing');
    expect(out.markers).toEqual(['corrected', 'checkout_missing']);
  });

  it('an empty override object is still a correction (corrected shown, nothing else shifts)', () => {
    // The read layer pre-filters deleted rows; a live empty-shaped row still says corrected.
    const out = computeDayStatus(input({ record: rec('09:25', '18:40'), override: ov(null, null) }));
    expect(out.status).toBe('present');
    expect(out.markers).toEqual(['corrected']);
  });
});

// ---- effectiveInstants — the per-field substitution -----------------------------
describe('effectiveInstants — per-field override substitution', () => {
  it('status-only: the record\'s instants and gps sources show through untouched', () => {
    const eff = effectiveInstants(rec('09:25', '18:40'), ov('half_day', null));
    expect(eff.checkin?.toISOString()).toBe('2026-09-28T03:55:00.000Z');
    expect(eff.checkout?.toISOString()).toBe('2026-09-28T13:10:00.000Z');
    expect(eff.checkinSource).toBe('gps');
    expect(eff.checkoutSource).toBe('gps');
  });

  it('a times-only check-in replaces the check-in alone (' +
     'checkout keeps its gps provenance)', () => {
    const eff = effectiveInstants(rec('09:25', '18:40'), ov(null, '10:00'));
    expect(eff.checkinSource).toBe('manual');
    expect(eff.checkoutSource).toBe('gps');
    expect(eff.checkout?.toISOString()).toBe('2026-09-28T13:10:00.000Z');
  });

  it('a checkout-ALONE override (defensive at the engine layer — the API gates it) keeps the record check-in gps', () => {
    const eff = effectiveInstants(rec('09:25', null), ov(null, null, '18:45'));
    expect(eff.checkinSource).toBe('gps');
    expect(eff.checkoutSource).toBe('manual');
    expect(eff.checkin?.toISOString()).toBe('2026-09-28T03:55:00.000Z');
  });

  it('both edges of BOTH fields come from the override (full replace)', () => {
    const eff = effectiveInstants(rec('09:25', '18:40'), ov(null, '10:00', '19:00'));
    expect(eff.checkinSource).toBe('manual');
    expect(eff.checkoutSource).toBe('manual');
    expect(eff.checkout?.toISOString()).toBe('2026-09-28T13:30:00.000Z');
  });

  it('no record AND no override → all nulls (a future empty day)', () => {
    expect(effectiveInstants(null, null)).toEqual({
      checkin: null, checkout: null,
      checkinSource: null, checkoutSource: null,
    });
  });

  it('a record with no checkout, no override → the check-in is gps and the checkout truly null', () => {
    const eff = effectiveInstants(rec('09:25', null), null);
    expect(eff.checkinSource).toBe('gps');
    expect(eff.checkoutSource).toBeNull();
    expect(eff.checkout).toBeNull();
  });
});
