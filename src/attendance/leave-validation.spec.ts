import { ErrorCode } from '../common/enums/error-code.enum';
import {
  countWorkingDays,
  enumerateDates,
  splitActionableDates,
  validateApplyFacts,
  validateApplyShape,
} from './leave-validation';
import type { SpanDayFacts } from './leave.repository';

/**
 * QA-mindset pins for the leave validation path (spec-17 D4/D6/D8/D9/D15).
 * These test the REQUIREMENT's behaviour, not the code's happy path:
 * boundaries (empty/zero/one/many, past/future edges), the rejection
 * ladder's order, and the split rule across the cutoff.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = '22222222-2222-4222-8222-222222222222';

function spanFacts(
  entries: Array<[string, boolean]>,
): Map<string, SpanDayFacts> {
  return new Map(
    entries.map(([date, isWorkingDay]) => [
      date,
      {
        date,
        isWorkingDay,
        kind: isWorkingDay ? 'working' : 'weekly_off',
      },
    ]),
  );
}

function factInput(
  overrides: Partial<Parameters<typeof validateApplyFacts>[1]> = {},
): Parameters<typeof validateApplyFacts>[1] {
  return {
    today: '2026-09-29',
    enrolment: { exists: true, floor: '2026-01-01', coversToday: true },
    settings: { setupCompleted: true, enabled: true },
    spanFacts: spanFacts([
      ['2026-09-22', true],
      ['2026-09-23', true],
      ['2026-09-28', true],
      ['2026-09-29', true],
      ['2026-09-30', true],
      ['2026-10-01', true],
      ['2026-10-02', true],
      ['2026-10-05', true],
      ['2026-10-06', true],
    ]),
    overlappingDates: [],
    checkedInDates: [],
    overrideDates: [],
    ...overrides,
  };
}

describe('validateApplyShape — format/pairing rules (D6)', () => {
  it('accepts a single date (the service coalesces endDate to startDate)', () => {
    expect(
      validateApplyShape({
        startDate: '2026-10-05',
        endDate: '2026-10-05',
        part: 'full_day',
      }),
    ).toBeNull();
  });

  it('rejects end before start', () => {
    expect(
      validateApplyShape({
        startDate: '2026-10-06',
        endDate: '2026-10-05',
        part: 'full_day',
      }),
    )?.toEqual(
      expect.objectContaining({ errorCode: ErrorCode.LEAVE_INVALID_RANGE }),
    );
  });

  it('rejects malformed dates', () => {
    const rejection = validateApplyShape({
      startDate: '2026-10-06T00:00:00Z',
      endDate: '2026-10-07',
      part: 'full_day',
    });
    expect(rejection).toEqual(
      expect.objectContaining({ errorCode: ErrorCode.LEAVE_INVALID_RANGE }),
    );
  });

  it('rejects a half-day part on a multi-date range (FR-12)', () => {
    expect(
      validateApplyShape({
        startDate: '2026-10-05',
        endDate: '2026-10-06',
        part: 'first_half',
      }),
    )?.toEqual(
      expect.objectContaining({ errorCode: ErrorCode.LEAVE_INVALID_RANGE }),
    );
    expect(
      validateApplyShape({
        startDate: '2026-10-05',
        endDate: '2026-10-05',
        part: 'second_half',
      }),
    ).toBeNull();
  });
});

describe('enumerateDates', () => {
  it('returns one entry per calendar date inclusive', () => {
    expect(enumerateDates('2026-09-30', '2026-10-02')).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('crosses month and year boundaries once each', () => {
    expect(enumerateDates('2026-12-31', '2027-01-01')).toEqual([
      '2026-12-31',
      '2027-01-01',
    ]);
  });
});

describe('validateApplyFacts — the gate and the five rejections, in order', () => {
  const dates = ['2026-09-29', '2026-09-30'];

  it('403s before setup completes and under the kill switch (raw-truth rule)', () => {
    for (const settings of [
      { setupCompleted: false, enabled: true },
      { setupCompleted: true, enabled: false },
    ]) {
      expect(
        validateApplyFacts(dates, factInput({ settings }))?.errorCode,
      ).toBe(ErrorCode.ATTENDANCE_NOT_TRACKED);
    }
  });

  it('403s a never-enrolled employee and a history-only employee (D9 gate)', () => {
    expect(
      validateApplyFacts(
        dates,
        factInput({
          enrolment: { exists: false, floor: null, coversToday: false },
        }),
      )?.errorCode,
    ).toBe(ErrorCode.ATTENDANCE_NOT_TRACKED);
    expect(
      validateApplyFacts(
        dates,
        factInput({
          enrolment: { exists: true, floor: '2026-01-01', coversToday: false },
        }),
      )?.errorCode,
    ).toBe(ErrorCode.ATTENDANCE_NOT_TRACKED);
  });

  it('admits an upcoming employee whose floor is in the future (FR-12 exact)', () => {
    expect(
      validateApplyFacts(
        ['2026-10-05'],
        factInput({
          enrolment: { exists: true, floor: '2026-10-05', coversToday: false },
        }),
      ),
    ).toBeNull();
    // …but not for a date BEFORE that start.
    expect(
      validateApplyFacts(
        ['2026-10-04'],
        factInput({
          enrolment: { exists: true, floor: '2026-10-05', coversToday: false },
        }),
      )?.errorCode,
    ).toBe(ErrorCode.LEAVE_BEFORE_START_DATE);
  });

  it('rejects a range starting before the enrolment floor, naming the floor', () => {
    const rejection = validateApplyFacts(
      ['2026-09-28'],
      factInput({
        enrolment: { exists: true, floor: '2026-09-29', coversToday: true },
      }),
    );
    expect(rejection).toEqual(
      expect.objectContaining({ errorCode: ErrorCode.LEAVE_BEFORE_START_DATE }),
    );
    expect(rejection?.message).toContain('2026-09-29');
  });

  it('enforces the 7-day-back limit on the boundary (exactly 7 OK, 8 rejected)', () => {
    expect(validateApplyFacts(['2026-09-22'], factInput())).toBeNull();
    expect(validateApplyFacts(['2026-09-21'], factInput())?.errorCode).toBe(
      ErrorCode.LEAVE_TOO_OLD,
    );
  });

  it('reports the floor before the 7-day rule when both bind (more specific first)', () => {
    const rejection = validateApplyFacts(
      ['2026-08-01'],
      factInput({
        enrolment: { exists: true, floor: '2026-09-01', coversToday: true },
      }),
    );
    expect(rejection?.errorCode).toBe(ErrorCode.LEAVE_BEFORE_START_DATE);
  });

  it('rejects when a date in the range already has a check-in — past AND today (D6)', () => {
    expect(
      validateApplyFacts(dates, factInput({ checkedInDates: ['2026-09-28'] }))
        ?.errorCode,
    ).toBe(ErrorCode.LEAVE_CHECKED_IN_CONFLICT);
    expect(
      validateApplyFacts(
        ['2026-09-29'],
        factInput({ checkedInDates: ['2026-09-29'] }),
      )?.errorCode,
    ).toBe(ErrorCode.LEAVE_CHECKED_IN_CONFLICT);
    // The D2 mirror gate (review G2-P1): a NON-ABSENT override on a span
    // date reads the same code with the correction message, naming the date.
    const rejected = validateApplyFacts(
      dates,
      factInput({ overrideDates: ['2026-09-30'] }),
    );
    expect(rejected?.errorCode).toBe(ErrorCode.LEAVE_CHECKED_IN_CONFLICT);
    expect(rejected?.message).toBe(
      'You have a correction on 2026-09-30. It cannot be requested as leave',
    );
  });

  it('admits leave over a plain `absent` correction (the only override leave may sit under)', () => {
    // The mirror gate's fact read only returns non-absent dates, so an
    // `absent`-only correction never appears — the permissive reading.
    expect(
      validateApplyFacts(dates, factInput({ overrideDates: [] })),
    ).toBeNull();
  });

  it('the check-in conflict outranks the correction conflict (checked-in already proves presence, D6 order)', () => {
    const rejection = validateApplyFacts(
      dates,
      factInput({
        checkedInDates: ['2026-09-29'],
        overrideDates: ['2026-09-30'],
      }),
    );
    expect(rejection?.errorCode).toBe(ErrorCode.LEAVE_CHECKED_IN_CONFLICT);
    expect(rejection?.message).toContain('already checked in');
  });

  it('rejects a range where every date is already off (FR-12 wording)', () => {
    const allOff = spanFacts([
      ['2026-09-27', false],
      ['2026-09-28', false],
    ]);
    const rejection = validateApplyFacts(
      ['2026-09-27', '2026-09-28'],
      factInput({ spanFacts: allOff }),
    );
    expect(rejection).toEqual(
      expect.objectContaining({
        errorCode: ErrorCode.LEAVE_ALREADY_OFF,
        message: 'These days are already off',
      }),
    );
    // Even when an off date carries a corrected override, the all-off
    // reading wins the report (review G2-P6: the specific rejection first).
    expect(
      validateApplyFacts(
        ['2026-09-27', '2026-09-28'],
        factInput({ spanFacts: allOff, overrideDates: ['2026-09-28'] }),
      )?.errorCode,
    ).toBe(ErrorCode.LEAVE_ALREADY_OFF);
  });

  it('admits a MIXED range and reports overlap last, naming the date', () => {
    const mixed = spanFacts([
      ['2026-09-29', false],
      ['2026-09-30', true],
    ]);
    expect(
      validateApplyFacts(
        ['2026-09-29', '2026-09-30'],
        factInput({ spanFacts: mixed }),
      ),
    ).toBeNull();
    expect(
      validateApplyFacts(
        dates,
        factInput({ overlappingDates: ['2026-09-30'] }),
      ),
    ).toEqual(expect.objectContaining({ errorCode: ErrorCode.LEAVE_OVERLAP }));
  });

  it('never reports overlap before every earlier rule has passed (ladder order)', () => {
    const rejection = validateApplyFacts(
      ['2026-09-21'],
      factInput({ overlappingDates: ['2026-09-21'] }),
    );
    expect(rejection?.errorCode).toBe(ErrorCode.LEAVE_TOO_OLD);
  });

  it('caps the span at 62 days in the SHAPE check — arithmetically, before any enumeration (D15 DoS bound)', () => {
    expect(
      validateApplyShape({ startDate: '2026-10-01', endDate: '2026-12-30', part: 'full_day' }),
    ).toEqual(expect.objectContaining({ errorCode: ErrorCode.LEAVE_INVALID_RANGE }));
    expect(
      validateApplyShape({ startDate: '2026-10-01', endDate: '2026-12-01', part: 'full_day' }),
    ).toBeNull(); // exactly 62 days
    // The facts-level ladder no longer caps — the shape check owns it.
    const long = enumerateDates('2026-10-01', '2026-12-30');
    expect(validateApplyFacts(long, factInput())).toBeNull();
  });
});

describe('splitActionableDates — the D8 rule', () => {
  const days = (
    states: Array<[string, 'pending' | 'approved' | 'cancelled']> = [],
  ) => states.map(([leave_date, state]) => ({ leave_date, state }));

  it('acts on future dates only when the cutoff has passed', () => {
    const split = splitActionableDates(
      days([
        ['2026-09-27', 'approved'],
        ['2026-09-29', 'approved'],
        ['2026-09-30', 'approved'],
      ]),
      {
        today: '2026-09-29',
        nowMinute: 600,
        startMinute: 540,
        sourceStates: ['approved'],
      },
    );
    expect(split.actionDates).toEqual(['2026-09-30']);
    expect(split.keepDates).toEqual([
      { date: '2026-09-27', state: 'approved', reason: 'past' },
      { date: '2026-09-29', state: 'approved', reason: 'cutoff_passed' },
    ]);
  });

  it('includes today while the cutoff has NOT passed — one minute before Start', () => {
    const split = splitActionableDates(
      days([
        ['2026-09-29', 'approved'],
        ['2026-09-30', 'approved'],
      ]),
      {
        today: '2026-09-29',
        nowMinute: 539,
        startMinute: 540,
        sourceStates: ['approved'],
      },
    );
    expect(split.actionDates).toEqual(['2026-09-29', '2026-09-30']);
  });

  it('treats now == Start as already started (the conservative minute)', () => {
    const split = splitActionableDates(days([['2026-09-29', 'approved']]), {
      today: '2026-09-29',
      nowMinute: 540,
      startMinute: 540,
      sourceStates: ['approved'],
    });
    expect(split.actionDates).toEqual([]);
    expect(split.keepDates).toEqual([
      { date: '2026-09-29', state: 'approved', reason: 'cutoff_passed' },
    ]);
  });

  it('treats a missing rule as cutoff NOT passed (D8 permissive reading)', () => {
    const split = splitActionableDates(days([['2026-09-29', 'approved']]), {
      today: '2026-09-29',
      nowMinute: 1200,
      startMinute: null,
      sourceStates: ['approved'],
    });
    expect(split.actionDates).toEqual(['2026-09-29']);
  });

  it('restricts to the source states (a cancelled day never re-enters)', () => {
    const split = splitActionableDates(
      days([
        ['2026-09-30', 'cancelled'],
        ['2026-10-01', 'approved'],
      ]),
      {
        today: '2026-09-29',
        nowMinute: 0,
        startMinute: null,
        sourceStates: ['approved'],
      },
    );
    expect(split.actionDates).toEqual(['2026-10-01']);
  });

  it('cancel takes pending AND approved days (FR-15)', () => {
    const split = splitActionableDates(
      days([
        ['2026-09-30', 'pending'],
        ['2026-10-01', 'approved'],
      ]),
      {
        today: '2026-09-29',
        nowMinute: 0,
        startMinute: null,
        sourceStates: ['pending', 'approved'],
      },
    );
    expect(split.actionDates).toEqual(['2026-09-30', '2026-10-01']);
  });
});

describe('countWorkingDays (D5)', () => {
  it('excludes off days from the count', () => {
    expect(
      countWorkingDays(
        ['2026-09-29', '2026-09-30'],
        spanFacts([
          ['2026-09-29', false],
          ['2026-09-30', true],
        ]),
      ),
    ).toBe(1);
  });

  it('answers 0 for an all-off span and 0 for an empty one', () => {
    expect(countWorkingDays([], spanFacts([]))).toBe(0);
    expect(
      countWorkingDays(['2026-09-27'], spanFacts([['2026-09-27', false]])),
    ).toBe(0);
  });
});
