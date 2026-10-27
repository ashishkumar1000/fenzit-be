import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, findByPhone, memberIdsOfTenant, parsePhone, type Target } from './core';
import type { Db } from './db';

export interface PurgeReceipt {
  deletedRows: number;
  loginsRemoved: number;
  loginsSkipped: number;
  backupPath: string;
  backupRows: number;
}

/**
 * The purge engine of the super CLI: delete one person (technician or
 * standalone) or one whole company (owner), straight through the schema's
 * RESTRICT foreign keys, in dependency order, inside one transaction.
 *
 * audit_log rows about the purged people/company go too: the append-only
 * triggers are disabled as table owner for the duration of the transaction
 * and re-enabled before commit — DDL is transactional, so a rollback (or a
 * crash mid-run) always restores the guard. No schema change, nothing left off.
 *
 * Deleting the Supabase auth identity is NOT done here — the caller does it
 * via the admin API before this runs, because a first OTP login re-creates
 * the public.users row whenever it is missing.
 *
 * The live foreign-key graph (refs to users/memberships/tenants, delete rules
 * RESTRICT or NO ACTION) is checked against EXPECTED_EDGES before every run;
 * a migration that adds or changes one aborts the tool instead of half-working.
 */

export interface Step {
  table: string;
  where: string;
  /** Per-step params — node-postgres binds positionally, so a step that
   *  references only $1 must receive exactly one value. */
  params: unknown[];
  /** This step touches audit_log — needs the append-only triggers suspended. */
  audit?: boolean;
  /** When set, the step UPDATEs rows instead of deleting them (e.g. clearing
   *  memberships.invited_by so other people keep their membership). Not
   *  backed up (nothing is lost) and not counted in the deleted total. */
  updateSet?: string;
}

/**
 * 2026-10-26 snapshot of every RESTRICT / NO-ACTION foreign key that
 * references users, memberships, tenants, jobs or customers. Compared
 * sorted (column order in pg_constraint differs between environments) and
 * CASCADE edges are ignored — they can never block a delete.
 * Checked, not trusted: any mismatch aborts the run.
 */
export const EXPECTED_EDGES: readonly string[] = [
  'activity_logs|actor_id|users|a',
  'attendance_attempts|employee_id,tenant_id|memberships|r',
  'attendance_corrections|actor_id|users|r',
  'attendance_corrections|employee_id,tenant_id|memberships|r',
  'attendance_day_overrides|created_by|users|r',
  'attendance_day_overrides|employee_id,tenant_id|memberships|r',
  'attendance_enrolments|employee_id,tenant_id|memberships|r',
  'attendance_office_assignments|employee_id,tenant_id|memberships|r',
  'attendance_onboarding|employee_id,tenant_id|memberships|r',
  'attendance_records|employee_id,tenant_id|memberships|r',
  'attendance_weekly_off_overrides|employee_id,tenant_id|memberships|r',
  'audit_log|actor_user_id|users|r',
  'audit_log|target_user_id|users|r',
  'audit_log|tenant_id|tenants|r',
  'attendance_corrections|employee_id,work_date|attendance_day_overrides|r',
  'attendance_office_assignments|office_id,tenant_id|attendance_offices|r',
  'attendance_office_rules|office_id|attendance_offices|r',
  'attendance_records|checkin_attempt_id|attendance_attempts|r',
  'attendance_records|checkout_attempt_id|attendance_attempts|r',
  'attendance_records|office_id,tenant_id|attendance_offices|r',
  'attendance_records|office_rules_id|attendance_office_rules|r',
  'jobs|customer_id|customers|r',
  'jobs|technician_id|users|r',
  'leave_events|actor_id|users|r',
  'leave_events|employee_id,tenant_id|memberships|r',
  'leave_events|leave_request_id|leave_requests|r',
  'leave_request_days|employee_id,tenant_id|memberships|r',
  'leave_request_days|leave_request_id|leave_requests|r',
  'leave_requests|created_by|users|r',
  'leave_requests|employee_id,tenant_id|memberships|r',
  'memberships|invited_by|users|r',
  'memberships|tenant_id|tenants|r',
  'memberships|user_id|users|r',
  'notifications|tenant_id|tenants|a',
  'notifications|user_id|users|a',
  'report_requests|requested_by|users|r',
  'tenants|created_by|users|r',
].sort();

const AUDIT_TRIGGERS = ['audit_log_no_change', 'audit_log_no_truncate'] as const;

/** Person mode: $1 = the user id. Everything that references the person goes. */
export function personPlan(userId: string): Step[] {
  const u = userId;
  const one = (table: string, where: string, audit = false): Step => ({
    table,
    where,
    params: [u],
    audit,
  });
  return [
    one('audit_log', 'actor_user_id = $1 OR target_user_id = $1', true),
    // The person's own activity plus everything on their jobs (a job's
    // activity may be authored by the owner) — one step, so no row is
    // backed up or counted twice.
    { table: 'activity_logs', where: 'actor_id = $1 OR job_id in (select id from public.jobs where technician_id = $1)', params: [u] },
    // corrections reference day_overrides (employee_id, work_date) — children first
    one('attendance_corrections', 'actor_id = $1 OR employee_id = $1'),
    one('attendance_day_overrides', 'created_by = $1 OR employee_id = $1'),
    // The target may have CREATED leave for other employees — those requests'
    // days and events (other employees' rows) RESTRICT-block the request
    // delete, so they go first via the request subquery.
    one('leave_events', 'actor_id = $1 OR employee_id = $1 OR leave_request_id in (select id from public.leave_requests where created_by = $1)'),
    one('leave_request_days', 'employee_id = $1 OR leave_request_id in (select id from public.leave_requests where created_by = $1)'),
    one('leave_requests', 'created_by = $1 OR employee_id = $1'),
    // records reference attempts — records must go first
    one('attendance_records', 'employee_id = $1'),
    one('attendance_attempts', 'employee_id = $1'),
    one('attendance_enrolments', 'employee_id = $1'),
    one('attendance_office_assignments', 'employee_id = $1'),
    one('attendance_onboarding', 'employee_id = $1'),
    one('attendance_weekly_off_overrides', 'employee_id = $1'),
    // The job's attachments CASCADE away with the job — delete and back them
    // up explicitly, or a restore brings the job back without its photos.
    { table: 'attachment_uploads', where: 'job_id in (select id from public.jobs where technician_id = $1)', params: [u] },
    { table: 'attachments', where: 'job_id in (select id from public.jobs where technician_id = $1)', params: [u] },
    one('jobs', 'technician_id = $1'),
    one('notifications', 'user_id = $1'),
    one('report_requests', 'requested_by = $1'),
    one('user_skills', 'user_id = $1'),
    { table: 'memberships', where: 'invited_by = $1', params: [u], updateSet: 'invited_by = NULL' },
    one('memberships', 'user_id = $1'),
    one('users', 'id = $1'),
  ];
}

/** Company mode: $1 = tenant id, $2 = uuid[] of every member. Everything goes. */
export function companyPlan(tenantId: string, memberIds: string[]): Step[] {
  const t = tenantId;
  const m = memberIds;
  const byTenant = (table: string): Step => ({ table, where: 'tenant_id = $1', params: [t] });
  // Cross-tenant twin of a person-scoped step: the member's rows everywhere
  // EXCEPT the company being purged.
  const ct = (table: string, where: string): Step => ({
    table,
    where: `(${where}) and tenant_id <> $2`,
    params: [m, t],
  });
  return [
    {
      table: 'audit_log',
      where: 'tenant_id = $1 OR actor_user_id = ANY($2::uuid[]) OR target_user_id = ANY($2::uuid[])',
      params: [t, m],
      audit: true,
    },
    // Members' history in OTHER tenants (as a past employee, or as the actor/
    // creator of someone else's records) RESTRICT-blocks both the memberships
    // and the users deletes — company mode erases members across tenants,
    // mirroring person mode. Child-first, mirroring personPlan's ordering.
    ct('attendance_corrections', 'employee_id = ANY($1::uuid[]) or actor_id = ANY($1::uuid[])'),
    ct('attendance_day_overrides', 'employee_id = ANY($1::uuid[]) or created_by = ANY($1::uuid[])'),
    ct('leave_events', 'employee_id = ANY($1::uuid[]) or actor_id = ANY($1::uuid[]) or leave_request_id in (select id from public.leave_requests where created_by = ANY($1::uuid[]))'),
    ct('leave_request_days', 'employee_id = ANY($1::uuid[]) or leave_request_id in (select id from public.leave_requests where created_by = ANY($1::uuid[]))'),
    ct('leave_requests', 'employee_id = ANY($1::uuid[]) or created_by = ANY($1::uuid[])'),
    ct('attendance_records', 'employee_id = ANY($1::uuid[])'),
    ct('attendance_attempts', 'employee_id = ANY($1::uuid[])'),
    ct('attendance_enrolments', 'employee_id = ANY($1::uuid[])'),
    ct('attendance_office_assignments', 'employee_id = ANY($1::uuid[])'),
    ct('attendance_onboarding', 'employee_id = ANY($1::uuid[])'),
    ct('attendance_weekly_off_overrides', 'employee_id = ANY($1::uuid[])'),
    ct('notifications', 'user_id = ANY($1::uuid[])'),
    ct('report_requests', 'requested_by = ANY($1::uuid[])'),
    ct('activity_logs', 'actor_id = ANY($1::uuid[])'),
    // The cross-tenant jobs' attachments CASCADE away with them — delete and
    // back them up explicitly, or a restore brings those jobs back without
    // their photos.
    ct('attachment_uploads', 'job_id in (select id from public.jobs where technician_id = ANY($1::uuid[]))'),
    ct('attachments', 'job_id in (select id from public.jobs where technician_id = ANY($1::uuid[]))'),
    ct('jobs', 'technician_id = ANY($1::uuid[])'),
    byTenant('activity_logs'),
    byTenant('attachment_uploads'),
    byTenant('attachments'),
    byTenant('notifications'),
    // records reference attempts, offices and office rules; corrections
    // reference day overrides; assignments and rules reference offices —
    // every child deletes before the table it points at.
    byTenant('attendance_records'),
    byTenant('attendance_corrections'),
    byTenant('attendance_day_overrides'),
    byTenant('attendance_office_assignments'),
    byTenant('attendance_attempts'),
    byTenant('attendance_office_rules'),
    byTenant('attendance_offices'),
    byTenant('attendance_enrolments'),
    byTenant('attendance_onboarding'),
    byTenant('attendance_weekly_off_overrides'),
    byTenant('leave_events'),
    byTenant('leave_request_days'),
    byTenant('leave_requests'),
    byTenant('attendance_settings'),
    byTenant('attendance_setup_progress'),
    byTenant('attendance_weekly_off_defaults'),
    byTenant('holidays'),
    byTenant('jobs'),
    byTenant('customers'),
    byTenant('report_requests'),
    byTenant('idempotency_log'),
    byTenant('job_sequences'),
    byTenant('employee_sequences'),
    { table: 'user_skills', where: 'user_id = ANY($1::uuid[])', params: [m] },
    byTenant('memberships'),
    { table: 'memberships', where: 'user_id = ANY($1::uuid[]) and tenant_id <> $2', params: [m, t] },
    // Members may have invited people whose memberships live on (in this or
    // another tenant) — NULL those links or the users delete RESTRICT-blocks.
    { table: 'memberships', where: 'invited_by = ANY($1::uuid[])', params: [m], updateSet: 'invited_by = NULL' },
    { table: 'tenants', where: 'id = $1', params: [t] },
    { table: 'users', where: 'id = ANY($1::uuid[])', params: [m] },
  ];
}

/** Abort unless the live FK graph still matches the snapshot this plan was built from.
 *  Covers edges INTO the roots (users/memberships/tenants/jobs/customers) AND
 *  edges between the plan's own tables — both decide the delete order. */
export async function checkSchemaDrift(db: Db): Promise<string[]> {
  const { rows } = await db.query(`
    select src.relname as table_name,
           (select string_agg(a.attname, ',' order by a.attname)
              from unnest(con.conkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = src.oid and a.attnum = k.attnum) as cols,
           tgt.relname as ref_table,
           con.confdeltype as on_delete
      from pg_constraint con
      join pg_class src on src.oid = con.conrelid
      join pg_class tgt on tgt.oid = con.confrelid
      join pg_namespace n on n.oid = src.relnamespace
     where con.contype = 'f' and n.nspname = 'public'
       and tgt.relname in (
         'users','memberships','tenants','jobs','customers',
         'audit_log','activity_logs','attachment_uploads','attachments','notifications',
         'attendance_day_overrides','attendance_corrections','leave_events','leave_request_days',
         'leave_requests','attendance_attempts','attendance_enrolments','attendance_office_assignments',
         'attendance_onboarding','attendance_records','attendance_weekly_off_overrides',
         'attendance_office_rules','attendance_offices','holidays',
         'user_skills','report_requests','attendance_settings','attendance_setup_progress',
         'attendance_weekly_off_defaults','idempotency_log','job_sequences','employee_sequences')
       and con.confdeltype in ('r','a')`);
  // The same columns can carry two constraints (e.g. r and a) — keep the strongest.
  const strongest = new Map<string, string>();
  for (const r of rows as Array<{ table_name: string; cols: string; ref_table: string; on_delete: string }>) {
    const sig = `${r.table_name}|${r.cols}|${r.ref_table}`;
    const prev = strongest.get(sig);
    if (prev !== 'r') strongest.set(sig, r.on_delete);
  }
  const live = [...strongest.entries()].map(([sig, del]) => `${sig}|${del}`).sort();
  const liveSet = new Set(live);
  const expectedSet = new Set(EXPECTED_EDGES);
  const problems: string[] = [];
  for (const edge of live) if (!expectedSet.has(edge)) problems.push(`new/changed: ${edge}`);
  for (const edge of EXPECTED_EDGES) if (!liveSet.has(edge)) problems.push(`gone: ${edge}`);
  return problems;
}

/** A step's predicate names columns this environment's table may not have —
 *  42703 (undefined column) means the table cannot hold matching rows, so the
 *  step is skipped and reported rather than failing the run. */
function isUndefinedColumn(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === '42703';
}

/** Dry-run counts per step. Tables that no longer exist are reported and
 *  skipped. UpdateSet steps change nothing irreversibly, so they are not
 *  counted — the confirm screen and the "Deleted N" receipt stay truthful. */
export async function countPlan(
  db: Db,
  steps: Step[],
): Promise<{ counts: Array<{ table: string; n: number }>; missingTables: string[] }> {
  const counts: Array<{ table: string; n: number }> = [];
  const missingTables: string[] = [];
  for (const step of steps) {
    if (step.updateSet) continue;
    const reg = await db.query(`select to_regclass('public.${step.table}') as reg`);
    if (!reg.rows[0].reg) {
      missingTables.push(step.table);
      continue;
    }
    try {
      const { rows } = await db.query(
        `select count(*)::int as n from public.${step.table} where ${step.where}`,
        step.params,
      );
      counts.push({ table: step.table, n: Number(rows[0].n) });
    } catch (err) {
      if (!isUndefinedColumn(err)) throw err;
      missingTables.push(`${step.table} (column mismatch)`);
    }
  }
  return { counts, missingTables };
}

/** The delete loop. MUST run inside a transaction: the audit-trigger DDL and
 *  the deletes are one unit, so a rollback restores the append-only guard.
 *  The transaction's 30s default statement timeout is lifted here — a big
 *  company's attendance delete is allowed to take as long as it takes. */
export async function runDeletes(
  tx: Db,
  steps: Step[],
  onStep: (table: string, deleted: number) => void,
): Promise<number> {
  await tx.query("SET LOCAL statement_timeout = '0'");
  const auditSteps = steps.filter((s) => s.audit);
  if (auditSteps.length > 0) {
    for (const t of AUDIT_TRIGGERS) {
      await tx.query(`ALTER TABLE public.audit_log DISABLE TRIGGER ${t}`);
    }
  }
  let total = 0;
  for (const step of steps) {
    const reg = await tx.query(`select to_regclass('public.${step.table}') as reg`);
    if (!reg.rows[0].reg) {
      if (!step.updateSet) onStep(step.table, 0);
      continue;
    }
    const { rowCount } = await (
      step.updateSet
        ? tx.query(`UPDATE public.${step.table} SET ${step.updateSet} WHERE ${step.where}`, step.params)
        : tx.query(`DELETE FROM public.${step.table} WHERE ${step.where}`, step.params)
    ).catch((err: unknown) => {
      if (!isUndefinedColumn(err)) throw err;
      return { rowCount: 0 };
    });
    const n = rowCount ?? 0;
    if (!step.updateSet) {
      total += n;
      onStep(step.table, n);
    }
  }
  if (auditSteps.length > 0) {
    for (const t of AUDIT_TRIGGERS) {
      await tx.query(`ALTER TABLE public.audit_log ENABLE TRIGGER ${t}`);
    }
  }
  return total;
}

/** The one destructive run. Everything in ONE transaction (commit on success, rollback on any failure). */
export function executePlan(
  db: Db,
  steps: Step[],
  onStep: (table: string, deleted: number) => void,
): Promise<number> {
  return db.transaction((tx) => runDeletes(tx, steps, onStep));
}

/** Removes each person's login identity via the admin API — purge calls this
 *  BEFORE the database work, because a first OTP re-creates the users row. */
export async function deleteAuthIdentities(ids: string[]): Promise<{ deleted: number; skipped: number }> {
  const url = process.env['SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — needed to remove logins.');
  }
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  let deleted = 0;
  let skipped = 0;
  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) {
      if (/not found|does not exist/i.test(error.message)) skipped += 1;
      else throw error;
    } else deleted += 1;
  }
  return { deleted, skipped };
}

/** Snapshots every row the purge would delete into tmp/, so restore can bring
 *  them back. UpdateSet steps are skipped — they only clear a reference
 *  (memberships.invited_by), and that link is deliberately NOT preserved
 *  across purge/restore, like logins. */
export async function backupPlan(
  db: Db,
  steps: Step[],
  filePath: string,
  meta: Record<string, unknown>,
): Promise<number> {
  const sections: Array<{ table: string; where: string; rows: unknown[] }> = [];
  for (const step of steps) {
    if (step.updateSet) continue;
    const reg = await db.query(`select to_regclass('public.${step.table}') as reg`);
    if (!reg.rows[0].reg) continue;
    const { rows } = await db.query(`select * from public.${step.table} where ${step.where}`, step.params);
    if (rows.length > 0) sections.push({ table: step.table, where: step.where, rows });
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ meta, sections }, null, 2), { mode: 0o600 });
  return sections.reduce((n, s) => n + s.rows.length, 0);
}

export interface PreparedPurge {
  target: Target;
  scope: string;
  plan: Step[];
  authIds: string[];
  counts: Array<{ table: string; n: number }>;
  missingTables: string[];
  total: number;
}

/** Resolves the phone to a person and builds the full purge plan with counts. Throws on drift or refusals. */
export async function preparePurge(db: Db, phoneArg?: string): Promise<PreparedPurge> {
  if (!phoneArg) throw new Error('usage: super purge <phone>');
  const target = await findByPhone(db, parsePhone(phoneArg));
  if (!target) throw new Error('No person with that number — find it with: super list <fragment>');
  if (target.kind === 'staff') {
    throw new Error(`${describe(target)} is staff — staff accounts are never touched by this tool.`);
  }
  const drift = await checkSchemaDrift(db);
  if (drift.length > 0) {
    throw new Error(`Schema drifted from the plan — update scripts/super/purge.ts first: ${drift.join('; ')}`);
  }
  if (target.kind === 'owner' && target.membership) {
    const tenantId = target.membership.tenantId;
    const liveElsewhere = await db.query(
      `select t.company_name, u.name, u.phone_number
         from public.memberships m
         join public.tenants t on t.id = m.tenant_id
         join public.users u on u.id = m.user_id
        where m.user_id = $1 and m.tenant_id <> $2 and m.status <> 'removed'`,
      [target.id, tenantId],
    );
    if (liveElsewhere.rowCount) {
      const others = (liveElsewhere.rows as Array<{ company_name: string; name: string | null; phone_number: string }>)
        .map((r) => `${r.name ?? r.phone_number} @ ${r.company_name}`)
        .join(', ');
      throw new Error(
        `${describe(target)} holds live memberships in other companies (${others}) — a company purge would abort on them. Clean those memberships up first.`,
      );
    }
    const memberIds = await memberIdsOfTenant(db, tenantId);
    const staffMembers = await db.query(
      `select name, phone_number from public.users where platform_admin and id = ANY($1::uuid[])`,
      [memberIds],
    );
    if (staffMembers.rowCount) {
      const names = (staffMembers.rows as Array<{ name: string | null; phone_number: string }>)
        .map((r) => `${r.name ?? r.phone_number}`)
        .join(', ');
      throw new Error(`Company "${target.membership.companyName}" includes fenzit staff (${names}) — staff accounts are never touched by this tool. Remove their membership first.`);
    }
    // A member who founded ANOTHER company pins their user row via
    // tenants.created_by RESTRICT — the company purge would abort on it.
    const foundedElsewhere = await db.query(
      `select u.name, u.phone_number, t2.company_name
         from public.tenants t2
         join public.users u on u.id = t2.created_by
        where t2.created_by = ANY($1::uuid[]) and t2.id <> $2`,
      [memberIds, tenantId],
    );
    if (foundedElsewhere.rowCount) {
      const names = (foundedElsewhere.rows as Array<{ name: string | null; phone_number: string; company_name: string }>)
        .map((r) => `${r.name ?? r.phone_number} (${r.company_name})`)
        .join(', ');
      throw new Error(`Members of this company founded other companies (${names}) — their accounts pin those tenants. Resolve that first.`);
    }
    // A departed founder (created this company, membership since removed)
    // pins it the same way and is unreachable in both purge modes.
    const departedFounder = await db.query(
      `select u.name, u.phone_number
         from public.tenants t
         join public.users u on u.id = t.created_by
        where t.id = $2
          and not exists (select 1 from public.memberships m
                           where m.tenant_id = t.id and m.user_id = t.created_by and m.status = 'active')`,
      [memberIds, tenantId],
    );
    if (departedFounder.rowCount) {
      const names = (departedFounder.rows as Array<{ name: string | null; phone_number: string }>)
        .map((r) => `${r.name ?? r.phone_number}`)
        .join(', ');
      throw new Error(`This company's founder (${names}) no longer has an active membership here — their account pins the company and cannot be purged by this tool. Remove that user row manually first.`);
    }
    const plan = companyPlan(tenantId, memberIds);
    const { counts, missingTables } = await countPlan(db, plan);
    return {
      target,
      scope: `COMPANY "${target.membership.companyName}" — every active member, customer, job and record in it (${memberIds.length} people)`,
      plan,
      authIds: memberIds,
      counts,
      missingTables,
      total: counts.reduce((n, c) => n + c.n, 0),
    };
  }
  const blocker = await db.query('select 1 from public.tenants where created_by = $1', [target.id]);
  if (blocker.rowCount) {
    throw new Error(`${describe(target)} founded a company — their account pins it. Purge the company via its current owner, or remove the account manually; this tool cannot purge a founder directly.`);
  }
  const plan = personPlan(target.id);
  const { counts, missingTables } = await countPlan(db, plan);
  return {
    target,
    scope: 'PERSON only — their jobs, attendance, leave, memberships and the records they authored; their company keeps everything else',
    plan,
    authIds: [target.id],
    counts,
    missingTables,
    total: counts.reduce((n, c) => n + c.n, 0),
  };
}

/** The destructive run: backup → logins → one-transaction delete. Reports phases and per-table counts. */
export async function executePurge(
  db: Db,
  prepared: PreparedPurge,
  report: {
    phase: (p: 'backup' | 'logins' | 'delete') => void;
    step: (table: string, n: number) => void;
  },
): Promise<PurgeReceipt> {
  report.phase('backup');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join('tmp', `purge-backup-${prepared.target.phoneNumber}-${stamp}.json`);
  const backupRows = await backupPlan(db, prepared.plan, backupPath, {
    version: 1,
    project: process.env['SUPABASE_URL']?.match(/https:\/\/([a-z0-9]+)\.supabase\.(?:co|in)/)?.[1] ?? '(unknown)',
    target: describe(prepared.target),
    scope: prepared.scope,
  });
  report.phase('logins');
  const auth = await deleteAuthIdentities(prepared.authIds);
  report.phase('delete');
  const deletedRows = await executePlan(db, prepared.plan, (table, n) => report.step(table, n));
  return { deletedRows, loginsRemoved: auth.deleted, loginsSkipped: auth.skipped, backupPath, backupRows };
}
