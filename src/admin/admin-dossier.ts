import type { PoolClient } from 'pg';

/**
 * The staff dossier — everything the database says about one person, as
 * true totals plus capped recent lists. A direct port of the super-CLI
 * whois (scripts/super/core.ts whoisReport) onto the API contract: the
 * same queries, camelCase rows, ISO timestamps, and the same degrade
 * rule — an enriching section whose table or column has drifted comes
 * back absent, never fails the request. Only the core counts are allowed
 * to be fatal. Read-only: every statement here is a SELECT.
 */

export interface DossierUser {
  id: string;
  name: string | null;
  countryCode: string;
  phoneNumber: string;
  email: string | null;
  platformAdmin: boolean;
  disabled: boolean;
  createdAt: string | null;
}

export interface DossierMembership {
  company: string;
  role: string;
  status: string;
  employeeCode: string | null;
  invitedBy: string | null;
  joined: string | null;
  isFounder: boolean;
}

export interface DossierOffice {
  name: string;
  address: string | null;
  radius: number | null;
  valid: string | null;
}

export interface DossierJob {
  jobNumber: string;
  status: string;
  priority: string | null;
  scheduledStart: string | null;
  currentStep: string | null;
  completedAt: string | null;
  serviceLocation: string | null;
  photos: number;
  customer: string | null;
  skill: string | null;
}

export interface DossierAttendance {
  recent: Array<{
    workDate: string;
    checkin: string | null;
    checkout: string | null;
    checkinDistance: number | null;
    checkoutDistance: number | null;
    mocked: boolean;
  }>;
  attempts: Array<{
    kind: string;
    outcome: string;
    provider: string | null;
    distance: number | null;
    mocked: boolean;
    createdAt: string | null;
  }>;
  records: number;
  attemptsCount: number;
  corrections: number;
  overrides: number;
  overridesAuthored: number;
  weeklyOff: number;
  enrolments: number;
}

export interface DossierLeaveItem {
  start: string;
  end: string;
  part: string;
  reason: string | null;
  lastState: string | null;
}

export interface DossierLeaveDay {
  date: string;
  state: string;
}

export interface DossierLeaveEvent {
  cause: string;
  actor: string | null;
  reason: string | null;
  dates: string | null;
  createdAt: string | null;
}

export interface DossierInvite {
  name: string | null;
  phone: string;
  company: string;
  role: string;
  status: string;
}

export interface DossierCorrection {
  workDate: string;
  employee: string | null;
  note: string | null;
}

export interface DossierNotification {
  event: string;
  summary: string | null;
  read: string | null;
  pushed: string | null;
  createdAt: string | null;
}

export interface DossierAuditRow {
  action: string;
  isActor: boolean;
  createdAt: string | null;
}

export interface DossierActivity {
  event: string;
  jobNumber: string | null;
  createdAt: string | null;
}

export interface DossierReport {
  type: string;
  status: string;
  createdAt: string | null;
}

export interface DossierCompany {
  name: string;
  members: number;
  customers: number;
  jobs: number;
  attendanceRows: number;
  address: string | null;
  state: string | null;
  timezone: string | null;
  isFounder: boolean;
  gstin: string | null;
  upi: string | null;
}

export interface Dossier {
  counts: {
    jobs: number;
    skills: number;
    auditRows: number;
    membershipsAll: number;
    notifications: number;
    attendanceRecords: number;
    attendanceAttempts: number;
    leaveRequests: number;
    reports: number;
    activityRows: number;
    invitesSent: number;
  };
  memberships: DossierMembership[];
  offices: DossierOffice[];
  jobs: DossierJob[];
  attendance: DossierAttendance;
  leave: DossierLeaveItem[];
  leaveDays: DossierLeaveDay[];
  leaveEvents: DossierLeaveEvent[];
  skills: string[];
  invites: { sent: DossierInvite[]; invitedBy: string | null };
  authored: { corrections: DossierCorrection[] };
  notifications: DossierNotification[];
  audit: DossierAuditRow[];
  activity: DossierActivity[];
  reports: DossierReport[];
  company: DossierCompany | null;
}

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v ?? 0);
const iso = (v: unknown): string | null => {
  if (v == null || (typeof v !== 'string' && !(v instanceof Date))) return null;
  return new Date(v).toISOString();
};
const str = (v: unknown): string | null => (v == null ? null : String(v));

/** One-line human summary of a notification payload — the known useful keys,
 *  in the order a person would read them (ported from the CLI). */
function payloadSummary(p: unknown): string | null {
  if (p === null || p === undefined || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of [
    'employeeName', 'officeName', 'leaveDate', 'workDate', 'startDate',
    'endDate', 'workingDays', 'pendingCount', 'notCheckedInCount',
  ]) {
    if (o[k] !== undefined && o[k] !== null) parts.push(String(o[k]));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function findUserByPhone(
  tx: PoolClient,
  phone: { countryCode: string; phoneNumber: string },
): Promise<DossierUser | null> {
  return tx
    .query(
      `select id, name, country_code, phone_number, email, platform_admin, disabled, created_at
         from public.users
        where country_code = $1 and phone_number = $2`,
      [phone.countryCode, phone.phoneNumber],
    )
    .then(({ rows }) => {
      const u = rows[0] as Row | undefined;
      if (!u) return null;
      return {
        id: String(u.id),
        name: str(u.name),
        countryCode: String(u.country_code),
        phoneNumber: String(u.phone_number),
        email: str(u.email),
        platformAdmin: Boolean(u.platform_admin),
        disabled: Boolean(u.disabled),
        createdAt: iso(u.created_at),
      };
    });
}

export async function buildDossier(
  tx: PoolClient,
  user: DossierUser,
  liveMembership: { tenantId: string; companyName: string } | null,
): Promise<Dossier> {
  const id = user.id;
  // Sections that merely enrich the dossier degrade to empty on schema
  // drift (missing table 42P01 / column 42703) or on a section that trips
  // the statement timeout (57014); only the core counts are allowed to be
  // fatal.
  const soft = (p: Promise<{ rows: Row[] }>): Promise<{ rows: Row[] }> =>
    p.catch((e: unknown) => {
      const code = (e as { code?: string } | null)?.code;
      if (code === '42P01' || code === '42703' || code === '57014') {
        return { rows: [] as Row[] };
      }
      throw e;
    });

  const counts = await tx.query(
    `select (select count(*) from public.jobs where technician_id = $1) as jobs,
            (select count(*) from public.user_skills where user_id = $1) as skills,
            (select count(*) from public.audit_log where actor_user_id = $1 or target_user_id = $1) as audit_rows,
            (select count(*) from public.memberships where user_id = $1) as memberships,
            (select count(*) from public.notifications where user_id = $1) as notifications`,
    [id],
  );
  const [
    webCounts, mems, offices, jobs, attRecent, attCounts, attempts, leave,
    leaveDays, leaveEvents, skills, invites, authored, notifs, audit, activity,
    reports, company,
  ] = await Promise.all([
    soft(tx.query(
      `select (select count(*) from public.attendance_records where employee_id = $1) as attendance_records,
              (select count(*) from public.attendance_attempts where employee_id = $1) as attendance_attempts,
              (select count(*) from public.leave_requests where employee_id = $1) as leave_requests,
              (select count(*) from public.report_requests where requested_by = $1) as reports,
              (select count(*) from public.activity_logs where actor_id = $1
                 or job_id in (select id from public.jobs where technician_id = $1)) as activity_rows,
              (select count(*) from public.memberships where invited_by = $1) as invites_sent`,
      [id],
    )),
    soft(tx.query(
      `select m.role, m.status, m.employee_code, m.created_at, t.company_name, t.created_by,
              (select u.name from public.users u where u.id = m.invited_by) as invited_by_name
         from public.memberships m join public.tenants t on t.id = m.tenant_id
        where m.user_id = $1 order by m.created_at`,
      [id],
    )),
    soft(tx.query(
      `select o.name, o.formatted_address, o.radius_m, oa.valid::text as valid
         from public.attendance_office_assignments oa
         join public.attendance_offices o on o.id = oa.office_id
        where oa.employee_id = $1 order by o.name`,
      [id],
    )),
    soft(tx.query(
      `select j.job_number, j.status, j.priority, j.scheduled_start, j.current_step,
              j.completed_at, j.service_location,
              (select count(*) from public.attachments where job_id = j.id) as photos,
              c.name as customer, s.name as skill
         from public.jobs j
         left join public.customers c on c.id = j.customer_id
         left join public.skills s on s.id = j.skill_id
        where j.technician_id = $1
        order by j.created_at desc limit 8`,
      [id],
    )),
    soft(tx.query(
      `select to_char(work_date, 'YYYY-MM-DD') as work_date, checkin_at, checkout_at,
              checkin_mocked as mocked, checkin_distance_m, checkout_distance_m
         from public.attendance_records where employee_id = $1
        order by work_date desc limit 5`,
      [id],
    )),
    soft(tx.query(
      `select (select count(*) from public.attendance_attempts where employee_id = $1) as attempts,
              (select count(*) from public.attendance_corrections where employee_id = $1 or actor_id = $1) as corrections,
              (select count(*) from public.attendance_day_overrides where employee_id = $1 or created_by = $1) as overrides,
              (select count(*) from public.attendance_day_overrides where created_by = $1) as overrides_authored,
              (select count(*) from public.attendance_weekly_off_overrides where employee_id = $1) as weekly_off,
              (select count(*) from public.attendance_enrolments where employee_id = $1) as enrolments`,
      [id],
    )),
    soft(tx.query(
      `select kind, outcome, provider, distance_m, mocked, created_at
         from public.attendance_attempts where employee_id = $1
        order by created_at desc limit 5`,
      [id],
    )),
    soft(tx.query(
      `select to_char(lr.start_date, 'YYYY-MM-DD') as start_date,
              to_char(lr.end_date, 'YYYY-MM-DD') as end_date, lr.part, lr.reason,
              (select lrd.state from public.leave_request_days lrd
                where lrd.leave_request_id = lr.id order by lrd.leave_date desc limit 1) as last_state
         from public.leave_requests lr where lr.employee_id = $1
        order by lr.created_at desc limit 5`,
      [id],
    )),
    soft(tx.query(
      `select to_char(leave_date, 'YYYY-MM-DD') as leave_date, state
         from public.leave_request_days
        where employee_id = $1 order by leave_date desc limit 10`,
      [id],
    )),
    soft(tx.query(
      `select le.cause, le.reason, le.affected_dates::text as dates, le.created_at,
              u.name as actor
         from public.leave_events le left join public.users u on u.id = le.actor_id
        where le.employee_id = $1 order by le.created_at desc limit 8`,
      [id],
    )),
    soft(tx.query(
      `select s.name from public.user_skills us join public.skills s on s.id = us.skill_id
        where us.user_id = $1 order by s.name`,
      [id],
    )),
    soft(tx.query(
      `select u.name, u.phone_number, t.company_name, m.role, m.status
         from public.memberships m
         join public.users u on u.id = m.user_id
         join public.tenants t on t.id = m.tenant_id
        where m.invited_by = $1 order by m.created_at desc limit 8`,
      [id],
    )),
    soft(tx.query(
      `select to_char(c.work_date, 'YYYY-MM-DD') as work_date, e.name as employee, c.note
         from public.attendance_corrections c left join public.users e on e.id = c.employee_id
        where c.actor_id = $1 order by c.created_at desc limit 5`,
      [id],
    )),
    soft(tx.query(
      `select event_type, payload, read_at, pushed_at, created_at from public.notifications
        where user_id = $1 order by created_at desc limit 5`,
      [id],
    )),
    soft(tx.query(
      `select action, (actor_user_id = $1) as is_actor, created_at from public.audit_log
        where actor_user_id = $1 or target_user_id = $1 order by created_at desc limit 5`,
      [id],
    )),
    soft(tx.query(
      `select a.event_type, j.job_number, a.created_at
         from public.activity_logs a left join public.jobs j on j.id = a.job_id
        where a.actor_id = $1 or a.job_id in (select id from public.jobs where technician_id = $1)
        order by a.created_at desc limit 5`,
      [id],
    )),
    soft(tx.query(
      `select report_type, status, created_at from public.report_requests
        where requested_by = $1 order by created_at desc limit 5`,
      [id],
    )),
    liveMembership
      ? soft(tx.query(
        `select (t.created_by = $2) as is_founder, t.address, t.state_code, t.timezone,
                t.gstin, t.upi_vpa,
                (select count(*) from public.customers where tenant_id = t.id) as customers,
                (select count(*) from public.jobs where tenant_id = t.id) as jobs,
                (select count(*) from public.memberships where tenant_id = t.id) as members,
                (select count(*) from public.attendance_records where tenant_id = t.id) as attendance_rows
           from public.tenants t where t.id = $1`,
        [liveMembership.tenantId, id],
      ))
      : Promise.resolve({ rows: [] as Row[] }),
  ]);

  const c = counts.rows[0] as Row;
  const wc = (webCounts.rows[0] ?? {}) as Row;
  const ac = (attCounts.rows[0] ?? {}) as Row; // soft-degraded counts must not crash the mapping
  const tr = company.rows[0] as Row | undefined;
  const inviter = (mems.rows as Row[]).find((m) => m.invited_by_name != null);

  return {
    counts: {
      jobs: num(c.jobs),
      skills: num(c.skills),
      auditRows: num(c.audit_rows),
      membershipsAll: num(c.memberships),
      notifications: num(c.notifications),
      attendanceRecords: num(wc.attendance_records),
      attendanceAttempts: num(wc.attendance_attempts),
      leaveRequests: num(wc.leave_requests),
      reports: num(wc.reports),
      activityRows: num(wc.activity_rows),
      invitesSent: num(wc.invites_sent),
    },
    memberships: (mems.rows as Row[]).map((m) => ({
      company: String(m.company_name),
      role: String(m.role),
      status: String(m.status),
      employeeCode: str(m.employee_code),
      invitedBy: str(m.invited_by_name),
      joined: iso(m.created_at),
      isFounder: m.created_by === id,
    })),
    offices: (offices.rows as Row[]).map((o) => ({
      name: String(o.name),
      address: str(o.formatted_address),
      radius: o.radius_m == null ? null : num(o.radius_m),
      valid: str(o.valid),
    })),
    jobs: (jobs.rows as Row[]).map((j) => ({
      jobNumber: String(j.job_number),
      status: String(j.status),
      priority: str(j.priority),
      scheduledStart: iso(j.scheduled_start),
      currentStep: str(j.current_step),
      completedAt: iso(j.completed_at),
      serviceLocation: str(j.service_location),
      photos: num(j.photos),
      customer: str(j.customer),
      skill: str(j.skill),
    })),
    attendance: {
      recent: (attRecent.rows as Row[]).map((r) => ({
        workDate: String(r.work_date),
        checkin: iso(r.checkin_at),
        checkout: iso(r.checkout_at),
        checkinDistance: r.checkin_distance_m == null ? null : num(r.checkin_distance_m),
        checkoutDistance: r.checkout_distance_m == null ? null : num(r.checkout_distance_m),
        mocked: Boolean(r.mocked),
      })),
      attempts: (attempts.rows as Row[]).map((a) => ({
        kind: String(a.kind),
        outcome: String(a.outcome),
        provider: str(a.provider),
        distance: a.distance_m == null ? null : num(a.distance_m),
        mocked: Boolean(a.mocked),
        createdAt: iso(a.created_at),
      })),
      records: num(wc.attendance_records),
      attemptsCount: num(ac.attempts),
      corrections: num(ac.corrections),
      overrides: num(ac.overrides),
      overridesAuthored: num(ac.overrides_authored),
      weeklyOff: num(ac.weekly_off),
      enrolments: num(ac.enrolments),
    },
    leave: (leave.rows as Row[]).map((l) => ({
      start: String(l.start_date),
      end: String(l.end_date),
      part: String(l.part),
      reason: str(l.reason),
      lastState: str(l.last_state),
    })),
    leaveDays: (leaveDays.rows as Row[]).map((d) => ({
      date: String(d.leave_date),
      state: String(d.state),
    })),
    leaveEvents: (leaveEvents.rows as Row[]).map((e) => ({
      cause: String(e.cause),
      actor: str(e.actor),
      reason: str(e.reason),
      dates: str(e.dates),
      createdAt: iso(e.created_at),
    })),
    skills: (skills.rows as Row[]).map((s) => String(s.name)),
    invites: {
      sent: (invites.rows as Row[]).map((i) => ({
        name: str(i.name),
        phone: String(i.phone_number),
        company: String(i.company_name),
        role: String(i.role),
        status: String(i.status),
      })),
      invitedBy: inviter ? String(inviter.invited_by_name) : null,
    },
    authored: {
      corrections: (authored.rows as Row[]).map((a) => ({
        workDate: String(a.work_date),
        employee: str(a.employee),
        note: str(a.note),
      })),
    },
    notifications: (notifs.rows as Row[]).map((n) => ({
      event: String(n.event_type),
      summary: payloadSummary(n.payload),
      read: iso(n.read_at),
      pushed: iso(n.pushed_at),
      createdAt: iso(n.created_at),
    })),
    audit: (audit.rows as Row[]).map((a) => ({
      action: String(a.action),
      isActor: Boolean(a.is_actor),
      createdAt: iso(a.created_at),
    })),
    activity: (activity.rows as Row[]).map((a) => ({
      event: String(a.event_type),
      jobNumber: str(a.job_number),
      createdAt: iso(a.created_at),
    })),
    reports: (reports.rows as Row[]).map((r) => ({
      type: String(r.report_type),
      status: String(r.status),
      createdAt: iso(r.created_at),
    })),
    company:
      liveMembership && tr
        ? {
          name: liveMembership.companyName,
          members: num(tr.members),
          customers: num(tr.customers),
          jobs: num(tr.jobs),
          attendanceRows: num(tr.attendance_rows),
          address: str(tr.address),
          state: str(tr.state_code),
          timezone: str(tr.timezone),
          isFounder: Boolean(tr.is_founder),
          gstin: str(tr.gstin),
          upi: str(tr.upi_vpa),
        }
        : null,
  };
}
