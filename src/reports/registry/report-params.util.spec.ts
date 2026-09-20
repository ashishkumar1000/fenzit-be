import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  MAX_REPORT_RANGE_DAYS,
  istTodayIso,
  validateReportDateRange,
} from './report-params.util';

/**
 * Shared date-range validation (NFR-3) used by every report definition —
 * story 12-5. The "future" check runs on the IST clock, so the tests that
 * touch it pin Date.now instead of the wall clock.
 */

function expectValidationError(fn: () => unknown, message: string) {
  expect(fn).toThrow(BadRequestException);
  try {
    fn();
  } catch (e) {
    const response = (e as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
    expect(response.error_code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(response.message).toBe(message);
  }
}

describe('ReportParamsUtil — validateReportDateRange (story 12-5)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts a valid past range and returns the dates unchanged', () => {
    expect(validateReportDateRange('2026-09-01', '2026-09-07')).toEqual({
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    });
  });

  it.each([
    ['2026/09/01', '2026-09-07'],
    ['01-09-2026', '2026-09-07'],
    ['2026-9-1', '2026-09-07'],
    ['', '2026-09-07'],
  ])(
    'rejects non-calendar-date shape %s with the format message',
    (start, end) => {
      expectValidationError(
        () => validateReportDateRange(start, end),
        'start_date and end_date must be calendar dates in YYYY-MM-DD format',
      );
    },
  );

  it.each([
    ['2026-02-30', '2026-02-30', '2026-02-30 rolls over in JS Date'],
    ['2026-13-01', '2026-13-01', 'month 13 rolls over'],
    ['2027-02-29', '2027-02-29', 'non-leap Feb 29 rolls over'],
  ])('rejects a shape-valid but impossible date %s', (start, end) => {
    expectValidationError(
      () => validateReportDateRange(start, end),
      'start_date and end_date must be real calendar dates',
    );
  });

  it('accepts a real leap day', () => {
    expect(validateReportDateRange('2024-02-01', '2024-02-29')).toEqual({
      startDate: '2024-02-01',
      endDate: '2024-02-29',
    });
  });

  it('rejects start_date after end_date', () => {
    expectValidationError(
      () => validateReportDateRange('2026-09-08', '2026-09-07'),
      'start_date cannot be after end_date',
    );
  });

  it(`allows an inclusive span of exactly ${MAX_REPORT_RANGE_DAYS} days`, () => {
    // 92 inclusive days = 91 days of gap.
    expect(() =>
      validateReportDateRange('2026-06-01', '2026-08-31'),
    ).not.toThrow();
  });

  it('rejects a span of 93 inclusive days with REPORT_RANGE_TOO_LARGE', () => {
    expect(() => validateReportDateRange('2026-05-31', '2026-08-31')).toThrow(
      BadRequestException,
    );
    try {
      validateReportDateRange('2026-05-31', '2026-08-31');
    } catch (e) {
      const response = (e as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response.error_code).toBe(ErrorCode.REPORT_RANGE_TOO_LARGE);
      expect(response.message).toBe('Date range cannot exceed 92 days');
    }
  });

  it('accepts end_date = today (a partial day is legitimate)', () => {
    const today = istTodayIso();
    expect(() => validateReportDateRange(today, today)).not.toThrow();
  });

  it('rejects an end_date in the future', () => {
    const today = istTodayIso();
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);

    expectValidationError(
      () => validateReportDateRange(today, tomorrow),
      'end_date cannot be in the future',
    );
  });
});

describe('ReportParamsUtil — istTodayIso (story 12-5)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports the IST calendar date, not the UTC date (UTC+5:30)', () => {
    // 2026-09-19T20:30Z + 5:30h = 2026-09-20T02:00 IST.
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-09-19T20:30:00Z'));

    expect(istTodayIso()).toBe('2026-09-20');
  });

  it('stays on the previous UTC day for early-IST-morning instants', () => {
    // 2026-09-20T18:29Z + 5:30h = 2026-09-20T23:59 IST — still the 20th.
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-09-20T18:29:00Z'));

    expect(istTodayIso()).toBe('2026-09-20');
  });
});