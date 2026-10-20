import { SupabaseClient } from '@supabase/supabase-js';
import { Role } from '../common/enums/role.enum';
import { CompanyMember, listCompanyMembers } from '../common/members/company-members';
import { istTodayIso } from '../reports/registry/report-params.util';

/** Longest name shown to the owner; anything longer is cut, never wrapped. */
const MAX_NAME_LENGTH = 80;

function displayName(member: CompanyMember): string {
  const name = (member.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return `Employee ${member.employeeCode}`;
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function idsOf(rows: unknown): Set<string> {
  return new Set(((rows ?? []) as Array<{ employee_id: string }>).map((r) => r.employee_id));
}

/**
 * The owner-facing reason when completion is refused for "no tracked employee".
 * An employee is tracked only when they are ACTIVE and have an enrolment and an
 * office assignment covering today (the database gate). So the invited people
 * named here are the ones who are enrolled and assigned for today but have not
 * signed in yet. Anyone missing an assignment is not named: that is a different
 * fix. Returns null when there is no such person.
 */
export async function invitedTrackedEmployeeReason(
  admin: SupabaseClient,
  tenantId: string,
): Promise<string | null> {
  try {
    const today = istTodayIso();
    const coversToday = `[${today},${today}]`;
    const [enrolments, assignments] = await Promise.all([
      admin
        .from('attendance_enrolments')
        .select('employee_id')
        .eq('tenant_id', tenantId)
        .filter('valid', 'ov', coversToday),
      admin
        .from('attendance_office_assignments')
        .select('employee_id')
        .eq('tenant_id', tenantId)
        .filter('valid', 'ov', coversToday),
    ]);
    if (enrolments.error || assignments.error) return null;

    const enrolled = idsOf(enrolments.data);
    const assigned = idsOf(assignments.data);
    const members = await listCompanyMembers(admin, tenantId, { role: Role.EMPLOYEE });
    const waiting = members.filter(
      (m) => m.status === 'invited' && enrolled.has(m.userId) && assigned.has(m.userId),
    );
    if (waiting.length === 0) return null;

    const verb = waiting.length === 1 ? 'has' : 'have';
    return `${joinNames(waiting.map(displayName))} ${verb} not signed in to the app yet. Tracking can start after their first sign-in.`;
  } catch {
    // The reason is a hint, never a gate: any failure keeps the generic message.
    return null;
  }
}

/** The database's gate messages start with this lead-in; the owner sees the reason after it. */
const GATE_LEAD_IN = /^attendance setup could not be completed:\s*/i;
const GENERIC_REASON =
  'Setup needs at least one office and one tracked employee with an office assignment';

/**
 * The exact reason a completion was refused. The database raises one specific
 * message per gate. For the "no tracked employee" gate, an enrolled, assigned
 * employee who has not signed in yet is named instead. Every failure to work it
 * out falls back to the database's own text, then to the generic sentence.
 */
export async function setupIncompleteMessage(
  admin: SupabaseClient,
  tenantId: string,
  error: { message?: string; details?: string | null },
): Promise<string> {
  const details = error.details ?? '';
  if (details.includes('no tracked employee')) {
    const invited = await invitedTrackedEmployeeReason(admin, tenantId);
    if (invited) return invited;
  }
  const text = (error.message ?? '').replace(GATE_LEAD_IN, '').trim();
  if (!text) return GENERIC_REASON;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
