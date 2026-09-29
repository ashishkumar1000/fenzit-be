/**
 * Pure model for corrections (Epic 18, 18-2): the FR-21 audit value shape
 * (the JSON `old_value`/`new_value` carry and the wire entries echo) and
 * the history view. No I/O, fully unit-testable.
 *
 * The audit value is the day's OBSERVABLE shape — the status, or the
 * instants, or both — never the override row itself. Instants travel as
 * tenant-offset ISO (AD-7) in wire entrys; the audit stores what the
 * response showed.
 */
import type { DayMarkerKey, DayStatusKey } from './day-status-response.model';
import { STATUS_KEYS_READONLY } from './day-status-response.model';
import { toTenantOffsetIso } from './check-in-out.model';

/** The audit JSON shape: exactly one of status XOR times (DTO-enforced). A
 *  seeded old_value carries the day's FR-10 grade — any status key. */
export interface CorrectionValue {
  status: DayStatusKey | null;
  checkinAt: string | null;
  checkoutAt: string | null;
}

export const EMPTY_CORRECTION_VALUE: CorrectionValue = Object.freeze({
  status: null,
  checkinAt: null,
  checkoutAt: null,
});

/** One history entry (owner or `me`, cursor-paginated). */
export interface CorrectionEntry {
  id: string;
  employeeId: string;
  workDate: string;
  correctedAt: string;
  actorName: string | null;
  /** Why the value changed (required, 1-500 after trim). */
  note: string;
  oldValue: CorrectionValue;
  newValue: CorrectionValue;
}

/** { correctedAt, actorName, note, oldValue, newValue } — the one-liner the
 *  day-detail sheet shows and the pre-fill source (the full history is the
 *  corrections read). */
export interface LatestCorrectionView {
  correctedAt: string;
  actorName: string | null;
  note: string;
  oldValue: CorrectionValue;
  newValue: CorrectionValue;
}

/** Wire entry builder (history rows, already-read). `correctedAt` travels
 *  as AD-7 tenant-offset ISO — the UTC/`Z` spelling would show the wrong
 *  wall time on the sheet (review G2-P9). */
export function toCorrectionEntry(
  row: {
    id: string;
    employee_id: string;
    work_date: string;
    created_at: Date | string;
    note: string;
    old_value: unknown;
    new_value: unknown;
  },
  actorName: string | null,
  timezone: string,
): CorrectionEntry {
  return {
    id: row.id,
    employeeId: row.employee_id,
    workDate: row.work_date,
    correctedAt: toTenantOffsetIso(new Date(row.created_at), timezone),
    actorName,
    note: row.note,
    oldValue: validateCorrectionValue(row.old_value),
    newValue: validateCorrectionValue(row.new_value),
  };
}

/**
 * The audit JSON columns are written by exactly one TS path (D4) — but the
 * read must not trust the stored shape blindly (the jsonb could carry an
 * old/foreign shape). Anything unexpected becomes an empty value, never a
 * crash.
 */
export function validateCorrectionValue(raw: unknown): CorrectionValue {
  if (typeof raw !== 'object' || raw === null) {
    return { ...EMPTY_CORRECTION_VALUE };
  }
  const value = raw as Partial<Record<keyof CorrectionValue | string, unknown>>;
  const status = value.status;
  return {
    status:
      typeof status === 'string' && STATUS_KEYS_READONLY.includes(status as never)
        ? (status as DayStatusKey)
        : null,
    checkinAt: typeof value.checkinAt === 'string' ? value.checkinAt : null,
    checkoutAt: typeof value.checkoutAt === 'string' ? value.checkoutAt : null,
  };
}

/** The markers the correction surface can act on (the sheet's rows). */
export const CORRECTION_MARKER_KEYS: readonly DayMarkerKey[] = [
  'corrected',
  'leave_pending',
  'checkout_missing',
  'fake_location_attempt',
];
