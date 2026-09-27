import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * A YYYY-MM-DD that also denotes a REAL calendar date. A shape-only regex
 * lets impossible values through (2026-13-01, 2026-02-30); those reach the
 * RPCs as garbage dates and either fail with an opaque 500 or land on the
 * wrong day. Rejecting them here yields a 422 via the global
 * ValidationPipe (the list-jobs-query precedent, copied for attendance).
 */
@ValidatorConstraint({ name: 'isAttendanceCalendarDate', async: false })
export class AttendanceCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const dt = new Date(Date.UTC(year, month - 1, day));
    // Round-trips only if the components survived JS Date's rollover
    // normalisation.
    return (
      dt.getUTCFullYear() === year &&
      dt.getUTCMonth() === month - 1 &&
      dt.getUTCDate() === day
    );
  }

  defaultMessage(): string {
    return 'date must be a valid calendar date in YYYY-MM-DD format';
  }
}
