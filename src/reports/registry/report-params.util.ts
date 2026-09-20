import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

/** NFR-3: a report's date range is capped at 92 days, counted inclusively. */
export const MAX_REPORT_RANGE_DAYS = 92;

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's calendar date on the IST clock — the PRD evaluates "not in the future" on IST. */
export function istTodayIso(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Parses a YYYY-MM-DD string into a UTC-midnight timestamp, rejecting
 * shape-only dates that JS Date would silently roll over (2026-02-30 → Mar 2).
 */
function parseCalendarDate(value: string): number {
  const m = CALENDAR_DATE_RE.exec(value);
  if (!m) {
    throw invalid(
      'start_date and end_date must be calendar dates in YYYY-MM-DD format',
    );
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    throw invalid('start_date and end_date must be real calendar dates');
  }
  return dt.getTime();
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({
    error_code: ErrorCode.VALIDATION_ERROR,
    message,
  });
}

/**
 * Shared date-range validation for every report type: ISO calendar dates,
 * start <= end, inclusive span capped at MAX_REPORT_RANGE_DAYS, and the range
 * not extending into the future (IST clock). The end date may be today — a
 * partial day is legitimate.
 */
export function validateReportDateRange(
  startDate: string,
  endDate: string,
): { startDate: string; endDate: string } {
  const startMs = parseCalendarDate(startDate);
  const endMs = parseCalendarDate(endDate);

  if (startMs > endMs) {
    throw invalid('start_date cannot be after end_date');
  }

  const inclusiveDays = (endMs - startMs) / 86_400_000 + 1;
  if (inclusiveDays > MAX_REPORT_RANGE_DAYS) {
    throw new BadRequestException({
      error_code: ErrorCode.REPORT_RANGE_TOO_LARGE,
      message: `Date range cannot exceed ${MAX_REPORT_RANGE_DAYS} days`,
    });
  }

  // Compare calendar dates as strings — both are YYYY-MM-DD, so lexicographic
  // order equals chronological order (no second IST-shift needed).
  if (endDate > istTodayIso()) {
    throw invalid('end_date cannot be in the future');
  }

  return { startDate, endDate };
}
