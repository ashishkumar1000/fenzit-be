/** attendance_offices row (snake_case, DB shape). */
export interface AttendanceOfficeRow {
  id: string;
  tenant_id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** attendance_office_rules row (snake_case, DB shape). */
export interface AttendanceOfficeRuleRow {
  id: string;
  office_id: string;
  tenant_id: string;
  /** PostgREST serialises daterange as e.g. "[2026-09-26,)" (empty upper = INF). */
  valid: string;
  start_time: string;
  end_time: string;
  late_cutoff_minutes: number;
  full_day_hours: string | number;
  half_day_hours: string | number;
  created_at: string;
  updated_at: string;
}

/** One effective-dated rule, times as "HH:mm", bounds as "YYYY-MM-DD". */
export interface OfficeRuleResponse {
  id: string;
  startTime: string;
  endTime: string;
  lateCutoffMinutes: number;
  fullDayHours: number;
  halfDayHours: number;
  /** Inclusive start date of the validity range. */
  validFrom: string;
  /** Exclusive end date, or null while the range is open-ended. */
  validTo: string | null;
}

/**
 * GET /attendance/offices — an Office with the rule valid on today (picked
 * here by pickCurrentRule against `attendance_today`, the recorded
 * fetch-and-pick deviation) and the earliest future rule (null when no edit
 * is pending).
 */
export interface OfficeResponse {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  archivedAt: string | null;
  rule: OfficeRuleResponse | null;
  nextRule: OfficeRuleResponse | null;
}

/** GET /attendance/offices/:id — full effective-dated history, ascending. */
export interface OfficeDetailResponse {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  archivedAt: string | null;
  rules: OfficeRuleResponse[];
}

/** GET /attendance/offices/:id/archive/preview and the archive 409 body. */
export interface ArchiveBlockersResponse {
  officeId: string;
  blockers: { employeeId: string; employeeName: string }[];
}

/** "[2026-09-26,)" → "2026-09-26" / "[2026-09-26,2026-09-27)" → upper. */
export function parseRuleRange(valid: string): { from: string; to: string | null } {
  const parts = valid.replace(/[\[\]()]/g, '').split(',');
  return { from: parts[0], to: parts[1] ? parts[1] : null };
}

/** "10:00:00" → "10:00" (times travel as HH:mm per the API convention). */
function toHhmm(value: string): string {
  return value.slice(0, 5);
}

export function toOfficeRuleResponse(row: AttendanceOfficeRuleRow): OfficeRuleResponse {
  const { from, to } = parseRuleRange(row.valid);
  return {
    id: row.id,
    startTime: toHhmm(row.start_time),
    endTime: toHhmm(row.end_time),
    lateCutoffMinutes: row.late_cutoff_minutes,
    fullDayHours: Number(row.full_day_hours),
    halfDayHours: Number(row.half_day_hours),
    validFrom: from,
    validTo: to,
  };
}

/** Rules are sorted by validFrom before mapping; last = current. */
export function toOfficeDetailResponse(
  office: AttendanceOfficeRow,
  rules: AttendanceOfficeRuleRow[],
): OfficeDetailResponse {
  return {
    id: office.id,
    name: office.name,
    latitude: office.latitude,
    longitude: office.longitude,
    radiusM: office.radius_m,
    archivedAt: office.archived_at,
    rules: [...rules]
      .sort((a, b) => parseRuleRange(a.valid).from.localeCompare(parseRuleRange(b.valid).from))
      .map(toOfficeRuleResponse),
  };
}

/**
 * The rule whose validity range contains `today` (a YYYY-MM-DD string from
 * attendance_today — the only source of "today", AD-7). PostgREST's range
 * operators cannot express element containment, so the selection is done on
 * the few fetched rows; lexicographic comparison of ISO dates is correct.
 */
export function pickCurrentRule(
  rules: AttendanceOfficeRuleRow[],
  today: string,
): AttendanceOfficeRuleRow | null {
  return (
    rules.find((r) => {
      const { from, to } = parseRuleRange(r.valid);
      return from <= today && (to === null || today < to);
    }) ?? null
  );
}

/** The earliest rule that starts after today (a pending rules edit). */
export function pickNextRule(
  rules: AttendanceOfficeRuleRow[],
  today: string,
): AttendanceOfficeRuleRow | null {
  const future = rules
    .filter((r) => parseRuleRange(r.valid).from > today)
    .sort((a, b) => parseRuleRange(a.valid).from.localeCompare(parseRuleRange(b.valid).from));
  return future[0] ?? null;
}