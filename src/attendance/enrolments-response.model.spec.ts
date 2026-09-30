import {
  AccessStateRow,
  addDays,
  parseDateRange,
  planAd8Change,
  serializeDateRange,
  toAccessStateResponse,
} from './enrolments-response.model';

/**
 * Pure-model spec for 15-7. The AD-8 plan lives here, so the algorithm is
 * pinned at the boundaries (empty / one / many ranges, same-day re-edit,
 * cancel-a-future-start, the covering-clip), not buried in SQL. Written as
 * a tester: each case names the requirement behaviour it protects, and a
 * change to the implementation (not the requirement) must not turn these
 * red.
 */

const row = (id: string, valid: string, enabledAt?: string) => ({
  id,
  valid,
  ...(enabledAt ? { enabled_at: enabledAt } : {}),
});

describe('parseDateRange / serializeDateRange', () => {
  it('parses the bounded and unbounded daterange literals pg returns', () => {
    expect(parseDateRange('[2026-09-27,)')).toEqual({
      start: '2026-09-27',
      end: null,
    });
    expect(parseDateRange('[2026-09-01,2026-11-01)')).toEqual({
      start: '2026-09-01',
      end: '2026-11-01',
    });
  });

  it('throws on a garbage literal instead of silently mis-clipping history', () => {
    expect(() => parseDateRange('2026-09-27')).toThrow(/Unparseable/);
    expect(() => parseDateRange('')).toThrow(/Unparseable/);
  });

  it('round-trips serialize(parse(range))', () => {
    const literal = '[2026-10-05,2026-11-01)';
    expect(serializeDateRange(parseDateRange(literal))).toBe(literal);
    expect(serializeDateRange({ start: '2026-10-05', end: null })).toBe(
      '[2026-10-05,)',
    );
  });
});

describe('addDays', () => {
  it('rolls over month and year boundaries in UTC date space', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-09-27', 1)).toBe('2026-09-28');
  });
});

describe('planAd8Change — FR-2 enable / change start date / disable', () => {
  it('a fresh enable inserts only — no history to touch', () => {
    expect(planAd8Change([], '2026-09-27', true)).toEqual({
      deleteIds: [],
      clipId: null,
      clipEnd: null,
      insertStart: '2026-09-27',
    });
  });

  it('re-enabling after a closed period keeps the past range untouched (history is read-only)', () => {
    const plan = planAd8Change([row('past', '[2026-01-01,2026-02-01)')], '2026-09-27', true);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.clipId).toBeNull();
    expect(plan.insertStart).toBe('2026-09-27');
  });

  it('a same-day re-edit replaces the open range (no zombie duplicates)', () => {
    // The open range starts exactly on effectiveFrom → deleted, not clipped.
    const plan = planAd8Change([row('open', '[2026-09-27,)')], '2026-09-27', true);
    expect(plan.deleteIds).toEqual(['open']);
    expect(plan.clipId).toBeNull();
    expect(plan.insertStart).toBe('2026-09-27');
  });

  it('moving a future start later clips the covering range at the new date and inserts the new one', () => {
    // Start 1 Nov, owner moves it to 5 Nov: [1 Nov, 5 Nov) + [5 Nov, ∞).
    const plan = planAd8Change([row('future', '[2026-11-01,)')], '2026-11-05', true);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.clipId).toBe('future');
    expect(plan.clipEnd).toBe('2026-11-05');
    expect(plan.insertStart).toBe('2026-11-05');
  });

  it('moving a future start earlier deletes the stale future range', () => {
    // Start 5 Nov, owner pulls it back to 1 Nov: the [5 Nov, ∞) row starts
    // on/after effectiveFrom → deleted; nothing covers 1 Nov yet.
    const plan = planAd8Change([row('future', '[2026-11-05,)')], '2026-11-01', true);
    expect(plan.deleteIds).toEqual(['future']);
    expect(plan.clipId).toBeNull();
    expect(plan.insertStart).toBe('2026-11-01');
  });

  it('disabling an active employee clips the covering range and inserts nothing', () => {
    const plan = planAd8Change([row('open', '[2026-09-15,)')], '2026-09-27', false);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.clipId).toBe('open');
    expect(plan.clipEnd).toBe('2026-09-27');
    expect(plan.insertStart).toBeNull();
  });

  it('cancelling a future start deletes the rows entirely (nothing covers today)', () => {
    const plan = planAd8Change([row('future', '[2026-11-01,)')], '2026-09-27', false);
    expect(plan.deleteIds).toEqual(['future']);
    expect(plan.clipId).toBeNull();
    expect(plan.insertStart).toBeNull();
  });

  it('a past effective date (already clamped by the service) clips the covering range like any other', () => {
    // effectiveFrom inside a CLOSED range: the row starts before the date,
    // so AD-8 clips it at the date and opens the new range there — the
    // planner is date-mechanical; the service guarantees it only ever
    // receives clamped-to-today dates.
    const plan = planAd8Change(
      [row('closed', '[2026-01-01,2026-02-01)')],
      '2026-01-15',
      true,
    );
    expect(plan.deleteIds).toEqual([]);
    expect(plan.clipId).toBe('closed');
    expect(plan.clipEnd).toBe('2026-01-15');
    expect(plan.insertStart).toBe('2026-01-15');
  });
});

describe('toAccessStateResponse', () => {
  const viewRow: AccessStateRow = {
    user_id: 'u1',
    tenant_id: 't1',
    attendance_enabled: true,
    access_state: 'upcoming',
    attendance_start_date: '2026-11-01',
    attendance_ended_on: null,
    enabled_at: null,
    onboarded_at: '2026-09-27T10:00:00+00:00',
    office_id: 'o1',
    office_name: 'Andheri West',
  };

  it('maps the snake_case view row to the API shape field for field', () => {
    expect(toAccessStateResponse(viewRow)).toEqual({
      attendanceEnabled: true,
      attendanceAccess: 'upcoming',
      attendanceStartDate: '2026-11-01',
      attendanceEndedOn: null,
      enabledAt: null,
      onboardedAt: '2026-09-27T10:00:00+00:00',
      officeId: 'o1',
      officeName: 'Andheri West',
    });
  });

  it('19-6: maps attendance_ended_on verbatim and degrades an absent column to null', () => {
    expect(
      toAccessStateResponse({
        ...viewRow,
        access_state: 'history_only',
        attendance_ended_on: '2026-08-31',
      }).attendanceEndedOn,
    ).toBe('2026-08-31');
    // An older view (pre-20260930000001) omits the column entirely.
    const legacy = toAccessStateResponse({
      ...viewRow,
      attendance_ended_on: undefined as unknown as string | null,
    });
    expect(legacy.attendanceEndedOn).toBeNull();
  });

  it('does not invent values the view did not send (a null stays null)', () => {
    const none = toAccessStateResponse({
      ...viewRow,
      access_state: 'none',
      attendance_start_date: null,
      office_id: null,
      office_name: null,
      onboarded_at: null,
    });
    expect(none.attendanceStartDate).toBeNull();
    expect(none.officeId).toBeNull();
    expect(none.onboardedAt).toBeNull();
  });
});
