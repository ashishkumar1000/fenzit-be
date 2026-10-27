import type { Db } from './db';

/**
 * Shared plumbing for the super-user CLI (scripts/super.tsx).
 *
 * Direct, service-level access — every command here is one the product APIs
 * deliberately do not offer. Run only against a database you are allowed to
 * break. Env (bun auto-loads .env): DATABASE_URL, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET.
 */

export interface Target {
  id: string;
  name: string | null;
  countryCode: string;
  phoneNumber: string;
  email: string | null;
  platformAdmin: boolean;
  disabled: boolean;
  /** Live membership (status <> 'removed'), if any. */
  membership: { tenantId: string; role: string; status: string; companyName: string } | null;
  /** 'staff' | 'owner' | 'technician' | 'standalone' — drives what each command may do. */
  kind: 'staff' | 'owner' | 'technician' | 'standalone';
  createdAt: Date | string | null;
}

export function fmtDate(v: Date | string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

export function fmtDateTime(v: Date | string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v.slice(0, 16) : '—';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function projectRef(): string {
  const url = process.env['SUPABASE_URL'] ?? '';
  const m = url.match(/https:\/\/([a-z0-9]+)\.supabase\.(co|in)/);
  return m ? m[1] : '(unknown project — SUPABASE_URL missing)';
}

export function envOrThrow(): void {
  for (const key of ['DATABASE_URL', 'SUPABASE_URL']) {
    if (!process.env[key]) {
      console.error(`Missing ${key} in env — run from fenzit-be with its .env present.`);
      process.exit(1);
    }
  }
}

/** Accepts 9876543210, 919876543210 and +91 98765 43210. India-only, like web login. */
export function parsePhone(input: string): { countryCode: string; phoneNumber: string } {
  const digits = input.replace(/[\s()+-]/g, '');
  if (/^\d{10}$/.test(digits)) return { countryCode: '+91', phoneNumber: digits };
  if (/^91\d{10}$/.test(digits)) {
    return { countryCode: '+91', phoneNumber: digits.slice(2) };
  }
  throw new Error(`Not a 10-digit Indian number (with optional 91 prefix): "${input}"`);
}

export async function findByPhone(
  client: Db,
  phone: { countryCode: string; phoneNumber: string },
): Promise<Target | null> {
  const { rows } = await client.query(
    `select id, name, country_code, phone_number, email, platform_admin, disabled, created_at
       from public.users
      where country_code = $1 and phone_number = $2`,
    [phone.countryCode, phone.phoneNumber],
  );
  if (rows.length === 0) return null;
  const u = rows[0] as {
    id: string;
    name: string | null;
    country_code: string;
    phone_number: string;
    email: string | null;
    platform_admin: boolean;
    disabled: boolean;
    created_at: Date | string | null;
  };
  const mem = await client.query(
    `select m.tenant_id, m.role, m.status, t.company_name
       from public.memberships m
       join public.tenants t on t.id = m.tenant_id
      where m.user_id = $1 and m.status <> 'removed'
      order by m.created_at
      limit 1`,
    [u.id],
  );
  const m = mem.rows[0] as
    | { tenant_id: string; role: string; status: string; company_name: string }
    | undefined;
  const kind: Target['kind'] = u.platform_admin
    ? 'staff'
    : m
      ? m.role === 'company_admin'
        ? 'owner'
        : 'technician'
      : 'standalone';
  return {
    id: u.id,
    name: u.name,
    countryCode: u.country_code,
    phoneNumber: u.phone_number,
    platformAdmin: u.platform_admin,
    disabled: u.disabled,
    membership: m
      ? { tenantId: m.tenant_id, role: m.role, status: m.status, companyName: m.company_name }
      : null,
    kind,
    email: u.email,
    createdAt: (u.created_at as Date | string | null) ?? null,
  };
}

export async function memberIdsOfTenant(client: Db, tenantId: string): Promise<string[]> {
  const { rows } = await client.query(
    `select user_id from public.memberships where tenant_id = $1 and status <> 'removed'`,
    [tenantId],
  );
  return rows.map((r) => r.user_id as string);
}

/** Append-only table, so only INSERT ever succeeds here. `actorIsStaff`
 *  records whether the actor held staff rights at action time — a demote
 *  writes false, so the trail never claims authority the actor just lost. */
export async function writeAudit(
  client: Db,
  actorUserId: string,
  action: string,
  details: Record<string, unknown>,
  actorIsStaff = true,
): Promise<void> {
  await client.query(
    `insert into public.audit_log (actor_user_id, actor_is_platform_admin, action, details)
     values ($1, $4, $2, $3::jsonb)`,
    [actorUserId, action, JSON.stringify(details), actorIsStaff],
  );
}

export function describe(t: Target): string {
  const company = t.membership ? ` · ${t.membership.companyName} (${t.membership.role})` : '';
  const flags = [t.platformAdmin ? 'STAFF' : null, t.disabled ? 'DISABLED' : null]
    .filter(Boolean)
    .join(' · ');
  return `${t.name ?? '(no name)'} +${t.countryCode.replace('+', '')}${t.phoneNumber} [${t.kind}]${company}${flags ? ' · ' + flags : ''}`;
}

/** Full whois as structured data — the interactive screen renders it as
 *  tables, the headless printer flattens it. Sections follow the 2026-10-27
 *  schema inventory: everything the DB can say about one person. */
export interface WhoisReport {
  target: Target;
  /** Login identities in auth — null when the auth schema is not readable here. */
  logins: number | null;
  counts: { jobs: number; skills: number; auditRows: number; membershipsAll: number; notifications: number };
  memberships: Array<{
    company: string; role: string; status: string; employeeCode: string | null;
    invitedBy: string | null; joined: Date | string | null; isFounder: boolean;
  }>;
  offices: Array<{ name: string; address: string | null; radius: number | null; valid: string | null }>;
  jobs: Array<{
    jobNumber: string; status: string; priority: string | null; scheduledStart: Date | string | null;
    currentStep: string | null; completedAt: Date | string | null; serviceLocation: string | null;
    photos: number; customer: string | null; skill: string | null;
  }>;
  attendance: {
    recent: Array<{
      workDate: Date | string; checkin: Date | string | null; checkout: Date | string | null;
      checkinDistance: number | null; checkoutDistance: number | null; mocked: boolean;
    }>;
    attempts: Array<{
      kind: string; outcome: string; provider: string | null; distance: number | null;
      mocked: boolean; createdAt: Date | string;
    }>;
    attemptsCount: number; corrections: number; overrides: number; overridesAuthored: number;
    weeklyOff: number; enrolments: number;
  };
  leave: Array<{ start: Date | string; end: Date | string; part: string; reason: string | null; lastState: string | null }>;
  leaveDays: Array<{ date: Date | string; state: string }>;
  leaveEvents: Array<{ cause: string; actor: string | null; reason: string | null; dates: string | null; createdAt: Date | string }>;
  skills: string[];
  invites: {
    sent: Array<{ name: string | null; phone: string; company: string; role: string; status: string }>;
    invitedBy: string | null;
  };
  authored: { corrections: Array<{ workDate: Date | string; employee: string | null; note: string | null }> };
  notifications: Array<{
    event: string; summary: string | null; read: Date | string | null;
    pushed: Date | string | null; createdAt: Date | string;
  }>;
  audit: Array<{ action: string; isActor: boolean; createdAt: Date | string }>;
  activity: Array<{ event: string; jobNumber: string | null; createdAt: Date | string }>;
  reports: Array<{ type: string; status: string; createdAt: Date | string }>;
  company: {
    name: string; members: number; customers: number; jobs: number; attendanceRows: number;
    address: string | null; state: string | null; timezone: string | null; isFounder: boolean;
    gstin: string | null; upi: string | null;
  } | null;
}

const num = (v: unknown): number => Number(v ?? 0);
const date = (v: unknown): Date | string | null => (v == null ? null : (v as Date | string));

/** One-line human summary of a notification payload — the known useful keys,
 *  in the order a person would read them. */
function payloadSummary(p: unknown): string | null {
  if (p === null || p === undefined || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ['employeeName', 'officeName', 'leaveDate', 'workDate', 'startDate', 'endDate', 'workingDays', 'pendingCount', 'notCheckedInCount']) {
    if (o[k] !== undefined && o[k] !== null) parts.push(String(o[k]));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export async function whoisReport(db: Db, target: Target): Promise<WhoisReport> {
  const id = target.id;
  const phone = `${target.countryCode}${target.phoneNumber}`;
  // Sections that merely enrich the dossier degrade to empty on schema drift;
  // only the counts query is allowed to be fatal.
  const soft = (p: Promise<{ rows: Record<string, unknown>[] }>) =>
    p.catch((e: unknown) => {
      const code = (e as { code?: string } | null)?.code;
      if (code === '42P01' || code === '42703') return { rows: [] as Record<string, unknown>[] };
      throw e;
    });

  const [
    countsRes, loginsRes, memsRes, officesRes, jobsRes, attRecentRes, attCountsRes,
    attemptsRes, leaveRes, leaveDaysRes, leaveEventsRes, skillsRes, invitesRes,
    authoredRes, notifRes, auditRes, actRes, repRes, companyRes,
  ] = await Promise.all([
    db.query(
      `select (select count(*) from public.jobs where technician_id = $1) as jobs,
              (select count(*) from public.user_skills where user_id = $1) as skills,
              (select count(*) from public.audit_log where actor_user_id = $1 or target_user_id = $1) as audit_rows,
              (select count(*) from public.memberships where user_id = $1) as memberships,
              (select count(*) from public.notifications where user_id = $1) as notifications`,
      [id],
    ),
    db.query(
      `select count(*)::int as n
         from auth.identities i join auth.users au on au.id = i.user_id
        where au.phone = $1`,
      [phone],
    ).catch(() => ({ rows: [{ n: null }] as Record<string, unknown>[] })),
    soft(db.query(
      `select m.role, m.status, m.employee_code, m.created_at, t.company_name, t.created_by,
              (select u.name from public.users u where u.id = m.invited_by) as invited_by_name
         from public.memberships m join public.tenants t on t.id = m.tenant_id
        where m.user_id = $1 order by m.created_at`,
      [id],
    )),
    soft(db.query(
      `select o.name, o.formatted_address, o.radius_m, oa.valid::text as valid
         from public.attendance_office_assignments oa
         join public.attendance_offices o on o.id = oa.office_id
        where oa.employee_id = $1 order by o.name`,
      [id],
    )),
    soft(db.query(
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
    soft(db.query(
      `select work_date, checkin_at, checkout_at, checkin_mocked as mocked,
              checkin_distance_m, checkout_distance_m
         from public.attendance_records where employee_id = $1
        order by work_date desc limit 5`,
      [id],
    )),
    soft(db.query(
      `select (select count(*) from public.attendance_attempts where employee_id = $1) as attempts,
              (select count(*) from public.attendance_corrections where employee_id = $1 or actor_id = $1) as corrections,
              (select count(*) from public.attendance_day_overrides where employee_id = $1 or created_by = $1) as overrides,
              (select count(*) from public.attendance_day_overrides where created_by = $1) as overrides_authored,
              (select count(*) from public.attendance_weekly_off_overrides where employee_id = $1) as weekly_off,
              (select count(*) from public.attendance_enrolments where employee_id = $1) as enrolments`,
      [id],
    )),
    soft(db.query(
      `select kind, outcome, provider, distance_m, mocked, created_at
         from public.attendance_attempts where employee_id = $1
        order by created_at desc limit 5`,
      [id],
    )),
    soft(db.query(
      `select lr.start_date, lr.end_date, lr.part, lr.reason,
              (select lrd.state from public.leave_request_days lrd
                where lrd.leave_request_id = lr.id order by lrd.leave_date desc limit 1) as last_state
         from public.leave_requests lr where lr.employee_id = $1
        order by lr.created_at desc limit 5`,
      [id],
    )),
    soft(db.query(
      `select leave_date, state from public.leave_request_days
        where employee_id = $1 order by leave_date desc limit 10`,
      [id],
    )),
    soft(db.query(
      `select le.cause, le.reason, le.affected_dates::text as dates, le.created_at,
              u.name as actor
         from public.leave_events le left join public.users u on u.id = le.actor_id
        where le.employee_id = $1 order by le.created_at desc limit 8`,
      [id],
    )),
    soft(db.query(
      `select s.name from public.user_skills us join public.skills s on s.id = us.skill_id
        where us.user_id = $1 order by s.name`,
      [id],
    )),
    soft(db.query(
      `select u.name, u.phone_number, t.company_name, m.role, m.status
         from public.memberships m
         join public.users u on u.id = m.user_id
         join public.tenants t on t.id = m.tenant_id
        where m.invited_by = $1 order by m.created_at desc limit 8`,
      [id],
    )),
    soft(db.query(
      `select c.work_date, e.name as employee, c.note
         from public.attendance_corrections c left join public.users e on e.id = c.employee_id
        where c.actor_id = $1 order by c.created_at desc limit 5`,
      [id],
    )),
    soft(db.query(
      `select event_type, payload, read_at, pushed_at, created_at from public.notifications
        where user_id = $1 order by created_at desc limit 5`,
      [id],
    )),
    soft(db.query(
      `select action, (actor_user_id = $1) as is_actor, created_at from public.audit_log
        where actor_user_id = $1 or target_user_id = $1 order by created_at desc limit 5`,
      [id],
    )),
    soft(db.query(
      `select a.event_type, j.job_number, a.created_at
         from public.activity_logs a left join public.jobs j on j.id = a.job_id
        where a.actor_id = $1 or a.job_id in (select id from public.jobs where technician_id = $1)
        order by a.created_at desc limit 5`,
      [id],
    )),
    soft(db.query(
      `select report_type, status, created_at from public.report_requests
        where requested_by = $1 order by created_at desc limit 5`,
      [id],
    )),
    target.membership
      ? soft(db.query(
        `select (t.created_by = $2) as is_founder, t.address, t.state_code, t.timezone,
                t.gstin, t.upi_vpa,
                (select count(*) from public.customers where tenant_id = t.id) as customers,
                (select count(*) from public.jobs where tenant_id = t.id) as jobs,
                (select count(*) from public.memberships where tenant_id = t.id) as members,
                (select count(*) from public.attendance_records where tenant_id = t.id) as attendance_rows
           from public.tenants t where t.id = $1`,
        [target.membership.tenantId, id],
      ))
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
  ]);
  const c = countsRes.rows[0];
  const ac = attCountsRes.rows[0] ?? {}; // soft-degraded counts must not crash the mapping
  const tr = companyRes.rows[0];

  // Unknown logins stay null (rendered "—") — never a fabricated 0.
  const rawLogins = loginsRes.rows[0]?.n;
  const logins: number | null = rawLogins == null ? null : Number(rawLogins);

  return {
    target,
    logins,
    counts: {
      jobs: num(c.jobs),
      skills: num(c.skills),
      auditRows: num(c.audit_rows),
      membershipsAll: num(c.memberships),
      notifications: num(c.notifications),
    },
    memberships: memsRes.rows.map((m) => ({
      company: String(m.company_name),
      role: String(m.role),
      status: String(m.status),
      employeeCode: m.employee_code == null ? null : String(m.employee_code),
      invitedBy: m.invited_by_name == null ? null : String(m.invited_by_name),
      joined: date(m.created_at),
      isFounder: m.created_by === id,
    })),
    offices: officesRes.rows.map((o) => ({
      name: String(o.name),
      address: o.formatted_address == null ? null : String(o.formatted_address),
      radius: o.radius_m == null ? null : num(o.radius_m),
      valid: o.valid == null ? null : String(o.valid),
    })),
    jobs: jobsRes.rows.map((j) => ({
      jobNumber: String(j.job_number),
      status: String(j.status),
      priority: j.priority == null ? null : String(j.priority),
      scheduledStart: date(j.scheduled_start),
      currentStep: j.current_step == null ? null : String(j.current_step),
      completedAt: date(j.completed_at),
      serviceLocation: j.service_location == null ? null : String(j.service_location),
      photos: num(j.photos),
      customer: j.customer == null ? null : String(j.customer),
      skill: j.skill == null ? null : String(j.skill),
    })),
    attendance: {
      recent: attRecentRes.rows.map((r) => ({
        workDate: r.work_date as Date | string,
        checkin: date(r.checkin_at),
        checkout: date(r.checkout_at),
        checkinDistance: r.checkin_distance_m == null ? null : num(r.checkin_distance_m),
        checkoutDistance: r.checkout_distance_m == null ? null : num(r.checkout_distance_m),
        mocked: Boolean(r.mocked),
      })),
      attempts: attemptsRes.rows.map((a) => ({
        kind: String(a.kind),
        outcome: String(a.outcome),
        provider: a.provider == null ? null : String(a.provider),
        distance: a.distance_m == null ? null : num(a.distance_m),
        mocked: Boolean(a.mocked),
        createdAt: a.created_at as Date | string,
      })),
      attemptsCount: num(ac.attempts),
      corrections: num(ac.corrections),
      overrides: num(ac.overrides),
      overridesAuthored: num(ac.overrides_authored),
      weeklyOff: num(ac.weekly_off),
      enrolments: num(ac.enrolments),
    },
    leave: leaveRes.rows.map((l) => ({
      start: l.start_date as Date | string,
      end: l.end_date as Date | string,
      part: String(l.part),
      reason: l.reason == null ? null : String(l.reason),
      lastState: l.last_state == null ? null : String(l.last_state),
    })),
    leaveDays: leaveDaysRes.rows.map((d) => ({
      date: d.leave_date as Date | string,
      state: String(d.state),
    })),
    leaveEvents: leaveEventsRes.rows.map((e) => ({
      cause: String(e.cause),
      actor: e.actor == null ? null : String(e.actor),
      reason: e.reason == null ? null : String(e.reason),
      dates: e.dates == null ? null : String(e.dates),
      createdAt: e.created_at as Date | string,
    })),
    skills: skillsRes.rows.map((s) => String(s.name)),
    invites: {
      sent: invitesRes.rows.map((i) => ({
        name: i.name == null ? null : String(i.name),
        phone: String(i.phone_number),
        company: String(i.company_name),
        role: String(i.role),
        status: String(i.status),
      })),
      invitedBy: memsRes.rows.find((m) => m.invited_by_name != null)
        ? String(memsRes.rows.find((m) => m.invited_by_name != null)!.invited_by_name)
        : null,
    },
    authored: {
      corrections: authoredRes.rows.map((c) => ({
        workDate: c.work_date as Date | string,
        employee: c.employee == null ? null : String(c.employee),
        note: c.note == null ? null : String(c.note),
      })),
    },
    notifications: notifRes.rows.map((n) => ({
      event: String(n.event_type),
      summary: payloadSummary(n.payload),
      read: date(n.read_at),
      pushed: date(n.pushed_at),
      createdAt: n.created_at as Date | string,
    })),
    audit: auditRes.rows.map((a) => ({
      action: String(a.action), isActor: Boolean(a.is_actor), createdAt: a.created_at as Date | string,
    })),
    activity: actRes.rows.map((a) => ({
      event: String(a.event_type),
      jobNumber: a.job_number == null ? null : String(a.job_number),
      createdAt: a.created_at as Date | string,
    })),
    reports: repRes.rows.map((r) => ({
      type: String(r.report_type), status: String(r.status), createdAt: r.created_at as Date | string,
    })),
    company: target.membership && tr
      ? {
        name: target.membership.companyName,
        members: num(tr.members),
        customers: num(tr.customers),
        jobs: num(tr.jobs),
        attendanceRows: num(tr.attendance_rows),
        address: tr.address == null ? null : String(tr.address),
        state: tr.state_code == null ? null : String(tr.state_code),
        timezone: tr.timezone == null ? null : String(tr.timezone),
        isFounder: Boolean(tr.is_founder),
        gstin: tr.gstin == null ? null : String(tr.gstin),
        upi: tr.upi_vpa == null ? null : String(tr.upi_vpa),
      }
      : null,
  };
}

/** Full whois as ready-to-print lines — headless twin of the interactive
 *  whois tables, derived from the same report. */
export async function whoisLines(db: Db, target: Target): Promise<string[]> {
  const r = await whoisReport(db, target);
  const hours = (a: { checkin: Date | string | null; checkout: Date | string | null }): string => {
    if (!a.checkin || !a.checkout) return 'OPEN';
    const ms = new Date(a.checkout).getTime() - new Date(a.checkin).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '?';
    return `${(ms / 3_600_000).toFixed(1)}h`;
  };
  const lines = [
    describe(r.target),
    `  jobs ${r.counts.jobs} · skills ${r.counts.skills} · audit ${r.counts.auditRows} · memberships ${r.counts.membershipsAll} · notifications ${r.counts.notifications}${r.logins === null ? '' : ` · logins ${r.logins}`}`,
  ];
  const section = (title: string, rows: string[]): void => {
    if (rows.length === 0) return;
    lines.push(`  ${title}:`);
    for (const row of rows) lines.push(`    ${row}`);
  };
  section('memberships', r.memberships.map((m) =>
    `${m.company} · ${m.role} · ${m.status}${m.employeeCode ? ` · ${m.employeeCode}` : ''}${m.isFounder ? ' · founder' : ''}${m.invitedBy ? ` · invited by ${m.invitedBy}` : ''} · joined ${fmtDateTime(m.joined)}`));
  section('invites sent', r.invites.sent.map((i) =>
    `${i.name ?? '(no name)'} · +91${i.phone} · ${i.company} · ${i.role} · ${i.status}`));
  section('offices', r.offices.map((o) =>
    `${o.name}${o.address ? ` · ${o.address}` : ''}${o.radius ? ` · ${o.radius}m` : ''}${o.valid ? ` · valid ${o.valid}` : ''}`));
  section('jobs (as technician)', r.jobs.map((j) =>
    `${j.jobNumber} · ${j.status}${j.priority === 'urgent' ? ' · URGENT' : ''}${j.currentStep ? ` · step ${j.currentStep}` : ''} · ${fmtDateTime(j.scheduledStart)}${j.photos ? ` · ${j.photos} photo(s)` : ''}${j.customer ? ` · ${j.customer}` : ''}${j.skill ? ` · ${j.skill}` : ''}`));
  if (r.attendance.recent.length > 0 || r.attendance.attemptsCount > 0) {
    section('attendance', [
      ...r.attendance.recent.map((a) =>
        `${fmtDate(a.workDate)} · in ${fmtDateTime(a.checkin)} · out ${fmtDateTime(a.checkout)} · ${hours(a)}${a.checkinDistance !== null ? ` · ${a.checkinDistance}m` : ''}${a.mocked ? ' · MOCKED' : ''}`),
      ...r.attendance.attempts.map((a) =>
        `${a.kind} · ${a.outcome}${a.provider ? ` · ${a.provider}` : ''}${a.distance !== null ? ` · ${a.distance}m` : ''}${a.mocked ? ' · MOCKED' : ''} · ${fmtDateTime(a.createdAt)}`),
      `counts: attempts ${r.attendance.attemptsCount} · corrections ${r.attendance.corrections} · overrides ${r.attendance.overrides} (authored ${r.attendance.overridesAuthored}) · weekly-off ${r.attendance.weeklyOff} · enrolments ${r.attendance.enrolments}`,
    ]);
  }
  section('authored moderations', r.authored.corrections.map((c) =>
    `${fmtDate(c.workDate)} · ${c.employee ?? '?'} · ${c.note ?? ''}`));
  section('leave', [
    ...r.leave.map((l) =>
      `${fmtDate(l.start)} → ${fmtDate(l.end)} · ${l.part}${l.lastState ? ` · ${l.lastState}` : ''}${l.reason ? ` · ${l.reason}` : ''}`),
    ...r.leaveDays.map((d) => `day ${fmtDate(d.date)} · ${d.state}`),
    ...r.leaveEvents.map((e) =>
      `${e.cause}${e.actor ? ` · ${e.actor}` : ''}${e.reason ? ` · ${e.reason}` : ''}${e.dates ? ` · ${e.dates}` : ''} · ${fmtDateTime(e.createdAt)}`),
  ]);
  if (r.skills.length > 0) section('skills', [r.skills.join(', ')]);
  section('activity (recent)', r.activity.map((a) =>
    `${a.event}${a.jobNumber ? ` · ${a.jobNumber}` : ''} · ${fmtDateTime(a.createdAt)}`));
  section('audit (recent)', r.audit.map((a) =>
    `${a.action} · ${a.isActor ? 'actor' : 'target'} · ${fmtDateTime(a.createdAt)}`));
  section('notifications (recent)', r.notifications.map((n) =>
    `${n.event}${n.summary ? ` · ${n.summary}` : ''} · ${n.read ? 'read' : 'unread'} · ${fmtDateTime(n.createdAt)}`));
  section('reports', r.reports.map((rep) =>
    `${rep.type} · ${rep.status} · ${fmtDateTime(rep.createdAt)}`));
  if (r.company) {
    lines.push(`  company "${r.company.name}": ${r.company.members} people · ${r.company.customers} customers · ${r.company.jobs} jobs · ${r.company.attendanceRows} attendance rows${r.company.isFounder ? ' · founded by this person' : ''}`);
    const loc = [r.company.address, r.company.state, r.company.timezone, r.company.gstin ? `GSTIN ✓` : null, r.company.upi ? `UPI ✓` : null].filter(Boolean).join(' · ');
    if (loc) lines.push(`  company location: ${loc}`);
  }
  return lines;
}

export interface ListRow {
  phone_number: string;
  name: string | null;
  platform_admin: boolean;
  disabled: boolean;
  role: string | null;
  status: string | null;
  company_name: string | null;
  created_at: Date | string | null;
}

/** LIKE pattern from a user fragment — % and _ are escaped so the fragment matches literally. */
export function likePattern(input: string): string {
  return `%${input.replace(/([%_\\])/g, '\\$1')}%`;
}

export async function listUsers(db: Db, query: string): Promise<ListRow[]> {
  const { rows } = await db.query(
    `select u.phone_number, u.name, u.platform_admin, u.disabled, m.role, m.status, t.company_name, u.created_at
       from public.users u
       left join public.memberships m on m.user_id = u.id and m.status <> 'removed'
       left join public.tenants t on t.id = m.tenant_id
      where u.phone_number like $1 or u.name ilike $1
      order by u.created_at desc limit 20`,
    [likePattern(query)],
  );
  return rows as unknown as ListRow[];
}

export function formatListRow(r: ListRow): string {
  return `  ${r.phone_number}  ${(r.name ?? '(no name)').padEnd(24).slice(0, 24)} ${(r.company_name ?? '-').padEnd(20).slice(0, 20)}${r.role ? ` (${r.role}/${r.status})` : ''}${r.platform_admin ? ' STAFF' : ''}${r.disabled ? ' DISABLED' : ''}`;
}

export interface StatDatum {
  key: string;
  value: number;
}

export async function statsData(db: Db): Promise<StatDatum[]> {
  const { rows } = await db.query(`select
    (select count(*) from public.users) as users,
    (select count(*) from public.users where platform_admin) as staff,
    (select count(*) from public.tenants) as companies,
    (select count(*) from public.memberships where status <> 'removed') as memberships,
    (select count(*) from public.customers) as customers,
    (select count(*) from public.jobs) as jobs,
    (select count(*) from public.notifications) as notifications,
    (select count(*) from public.attendance_records) as attendance_rows,
    (select count(*) from public.audit_log) as audit_rows`);
  return Object.entries(rows[0]).map(([k, v]) => ({ key: k, value: num(v) }));
}

export async function statsLines(db: Db): Promise<string[]> {
  return (await statsData(db)).map((d) => `  ${d.key.padEnd(16)}${d.value.toLocaleString('en-IN')}`);
}
