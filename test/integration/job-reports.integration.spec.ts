/**
 * Story 6 — job reports and the approval queue (CAP-8, CAP-9 data, CAP-10) —
 * real DEV database suite. Each test builds its own throwaway company.
 *
 * Plain English: the owner's numbers and the employee's own numbers are worked
 * out from real job rows. The owner sees every employee's jobs; an employee
 * sees only their own. The approval queue lists only jobs waiting for a
 * decision, oldest first, and an employee never sees another employee's queue.
 * Windows are IST calendar days. Reads past 1,000 rows must not be cut short.
 *
 * The services run exactly as in production, against the service-role client.
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import {
  IS_REAL_DB,
  POINTS_AT_LIVE,
  mid,
  randomPhone,
  seedPlatformAdmin,
  call,
} from '../helpers/member-functions-fixture';
import {
  makeCompany,
  teardownSuite,
} from '../helpers/member-functions-company';
import { serviceRoleClient } from '../helpers/rls-seed';
import { JobReportsService } from '../../src/job-reports/job-reports.service';
import { ApprovalQueueService } from '../../src/job-reports/approval-queue.service';
import { istDateOf } from '../../src/job-reports/job-report-data';
import { Role } from '../../src/common/enums/role.enum';
import type { RequestUser } from '../../src/common/interfaces/request-user.interface';
import type { SupabaseClientFactory } from '../../src/common/factories/supabase-client.factory';
import type { SupabaseClient } from '@supabase/supabase-js';

const PA = mid('a601', 1);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Company {
  tenantId: string;
  id: Record<string, string>;
}

describe('job reports and approval queue (real DB, story 6)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);
  jest.setTimeout(300000);

  // The services take a client factory; production passes the admin client.
  const factory = {
    createAdmin: (): SupabaseClient => service,
  } as unknown as SupabaseClientFactory;
  const reports = new JobReportsService(factory);
  const queue = new ApprovalQueueService(factory);

  let skillId: string;
  let templateId: string;
  let templateVersion: number;

  const today = () => istDateOf(new Date());
  const daysAgo = (n: number) => istDateOf(new Date(Date.now() - n * DAY_MS));
  const who = (c: Company, name: string, role: Role): RequestUser => ({
    userId: c.id[name],
    tenantId: c.tenantId,
    role,
    platformAdmin: false,
    rawJwt: '',
  });

  const createCustomer = async (tenantId: string) => {
    const { data, error } = await service
      .from('customers')
      .insert({
        tenant_id: tenantId,
        name: 'RP customer',
        country_code: '+91',
        phone_number: randomPhone(),
      })
      .select('id')
      .single<{ id: string }>();
    expect(error).toBeNull();
    return data!.id;
  };

  /** A job through the real create RPC; pending when `asEmployee` submits it. */
  const createJob = async (
    c: Company,
    customerId: string,
    creator: string,
    pending: boolean,
  ): Promise<string> => {
    const r = await call<Array<{ id: string }>>(
      service,
      'create_job_with_log',
      {
        p_tenant_id: c.tenantId,
        p_customer_id: customerId,
        p_technician_id: c.id.admin,
        p_actor_id: creator,
        p_created_by: creator,
        p_pending_approval: pending,
        p_service_location: 'RP location',
        p_skill_id: skillId,
        p_scheduled_start: new Date().toISOString(),
        p_scheduled_end: null,
        p_description: 'RP job',
        p_priority: 'normal',
        p_notes_for_technician: null,
        p_year: new Date().getUTCFullYear(),
      },
    );
    expect(r.error).toBeNull();
    return r.data![0].id;
  };

  const decide = async (
    c: Company,
    jobId: string,
    decision: 'approve' | 'reject',
    reason?: string,
  ) => {
    const r = await call(service, 'decide_pending_job', {
      p_caller: c.id.admin,
      p_tenant_id: c.tenantId,
      p_job_id: jobId,
      p_decision: decision,
      p_reason: reason ?? null,
    });
    expect(r.error).toBeNull();
  };

  const setJob = async (jobId: string, fields: Record<string, unknown>) => {
    const { error } = await service.from('jobs').update(fields).eq('id', jobId);
    expect(error).toBeNull();
  };

  const setCanCreate = async (c: Company, name: string, on: boolean) => {
    const { error } = await service
      .from('memberships')
      .update({ can_create_jobs: on })
      .eq('tenant_id', c.tenantId)
      .eq('user_id', c.id[name]);
    expect(error).toBeNull();
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    expect(POINTS_AT_LIVE).toBe(false);
    await teardownSuite(service);
    await seedPlatformAdmin(service, PA, randomPhone());
    const { data: skill } = await service
      .from('skills')
      .select('id')
      .eq('is_active', true)
      .limit(1)
      .single<{ id: string }>();
    skillId = skill!.id;
    const { data: tpl } = await service
      .from('workflow_templates')
      .select('id, version')
      .limit(1)
      .single<{ id: string; version: number }>();
    templateId = tpl!.id;
    templateVersion = tpl!.version;
  }, 120000);

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service, [], [PA]);
  }, 120000);

  // ---- Owner report (CAP-8) ----------------------------------------------

  maybeIt(
    'owner headline and pipeline match the real outcomes of each job',
    async () => {
      const c = await makeCompany(service, 'rp owner mix', {
        admin: { role: 'company_admin' },
        emp1: { role: 'employee' },
        emp2: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      const admin = c.id.admin;
      const e1 = c.id.emp1;
      const e2 = c.id.emp2;

      await createJob(c, cust, admin, false); // owner job
      await createJob(c, cust, e1, true); // still waiting for a decision
      const approved = await createJob(c, cust, e1, true);
      await decide(c, approved, 'approve');
      const rejected = await createJob(c, cust, e1, true);
      await decide(c, rejected, 'reject', 'Wrong site');
      const cancelled = await createJob(c, cust, e2, true);
      await call(service, 'update_job_with_log', {
        p_job_id: cancelled,
        p_tenant_id: c.tenantId,
        p_actor_id: admin,
        p_cancel: true,
        p_description: null,
        p_scheduled_start: null,
        p_scheduled_end: null,
        p_notes_for_technician: null,
        p_technician_id: null,
        p_priority: null,
      });
      await createJob(c, cust, e2, false); // employee job, no approval needed

      const r = await reports.ownerReport(who(c, 'admin', Role.COMPANY_ADMIN), {
        from: today(),
        to: today(),
      });

      expect(r.headline).toEqual({
        employeeCreated: 5,
        employeeApproved: 1,
        employeeAutoApproved: 1,
        ownerCreated: 1,
      });
      expect(r.pipeline).toMatchObject({
        pending: 1,
        rejected: 1,
        rejectedWithReason: 1,
        rejectedWithoutReason: 0,
        pendingOverOneDay: 0,
      });
      expect(r.pipeline.oldestPending?.id ?? null).not.toBeNull();
      expect(r.pipeline.approvalRate).toBeCloseTo(0.5, 4); // 1 approved / (1 + 1)

      const byEmp = Object.fromEntries(
        r.perEmployee.map((row) => [row.employeeId, row]),
      );
      expect(byEmp[e1]).toMatchObject({
        created: 3,
        approved: 1,
        rejected: 1,
        pending: 1,
      });
      expect(byEmp[e2]).toMatchObject({
        created: 2,
        cancelled: 1,
        autoApproved: 1,
      });
      // The cancelled job is its own bucket, never approved (decision a).
      expect(byEmp[e2].approved).toBe(0);
    },
  );

  maybeIt(
    'an employee with creation switched on and no jobs is listed as a candidate',
    async () => {
      const c = await makeCompany(service, 'rp candidates', {
        admin: { role: 'company_admin' },
        busy: { role: 'employee' },
        idle: { role: 'employee' },
        off: { role: 'employee' },
      });
      await setCanCreate(c, 'busy', true);
      await setCanCreate(c, 'idle', true);
      await setCanCreate(c, 'off', false);
      const cust = await createCustomer(c.tenantId);
      await createJob(c, cust, c.id.busy, true);

      const r = await reports.ownerReport(who(c, 'admin', Role.COMPANY_ADMIN), {
        from: today(),
        to: today(),
      });
      const ids = r.employeesWithPermissionNoJobs.map((e) => e.employeeId);
      expect(ids).toContain(c.id.idle);
      expect(ids).not.toContain(c.id.busy); // created a job, so not a candidate
      expect(ids).not.toContain(c.id.off); // creation switched off
    },
  );

  maybeIt(
    'a removed employee keeps their jobs and is still named in the breakdown',
    async () => {
      const c = await makeCompany(service, 'rp removed', {
        admin: { role: 'company_admin' },
        gone: { role: 'employee', status: 'removed' },
      });
      const cust = await createCustomer(c.tenantId);
      await createJob(c, cust, c.id.gone, true);

      const r = await reports.ownerReport(who(c, 'admin', Role.COMPANY_ADMIN), {
        from: today(),
        to: today(),
      });
      expect(r.perEmployee).toEqual([
        expect.objectContaining({
          employeeId: c.id.gone,
          created: 1,
          pending: 1,
        }),
      ]);
      expect(r.headline.employeeCreated).toBe(1);
    },
  );

  maybeIt(
    'a pending job older than 24 hours counts as overdue; a fresh one does not',
    async () => {
      const c = await makeCompany(service, 'rp overdue', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      const old = await createJob(c, cust, c.id.emp, true);
      await createJob(c, cust, c.id.emp, true);
      await setJob(old, {
        created_at: new Date(Date.now() - 25 * HOUR_MS).toISOString(),
      });

      const r = await reports.ownerReport(who(c, 'admin', Role.COMPANY_ADMIN), {
        from: daysAgo(2),
        to: today(),
      });
      expect(r.pipeline.pending).toBe(2);
      expect(r.pipeline.pendingOverOneDay).toBe(1);
      expect(r.pipeline.oldestPending?.id).toBe(old);
    },
  );

  maybeIt(
    'a job outside the IST window is not counted; the window edges are inclusive',
    async () => {
      const c = await makeCompany(service, 'rp window', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      await createJob(c, cust, c.id.emp, true); // created now = today IST

      const ownerUser = who(c, 'admin', Role.COMPANY_ADMIN);
      const yesterday = await reports.ownerReport(ownerUser, {
        from: daysAgo(1),
        to: daysAgo(1),
      });
      expect(yesterday.headline.employeeCreated).toBe(0);
      const tomorrow = await reports.ownerReport(ownerUser, {
        from: istDateOf(new Date(Date.now() + DAY_MS)),
        to: istDateOf(new Date(Date.now() + DAY_MS)),
      });
      expect(tomorrow.headline.employeeCreated).toBe(0);
      const inclusive = await reports.ownerReport(ownerUser, {
        from: daysAgo(1),
        to: today(),
      });
      expect(inclusive.headline.employeeCreated).toBe(1);
    },
  );

  maybeIt(
    "another company's jobs never leak into this owner report",
    async () => {
      const mine = await makeCompany(service, 'rp tenant a', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const other = await makeCompany(service, 'rp tenant b', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      await createJob(
        other,
        await createCustomer(other.tenantId),
        other.id.emp,
        true,
      );
      await createJob(
        mine,
        await createCustomer(mine.tenantId),
        mine.id.emp,
        true,
      );

      const r = await reports.ownerReport(
        who(mine, 'admin', Role.COMPANY_ADMIN),
        {
          from: today(),
          to: today(),
        },
      );
      expect(r.headline.employeeCreated).toBe(1);
      expect(r.perEmployee.map((row) => row.employeeId)).toEqual([mine.id.emp]);
    },
  );

  // ---- Paging past 1,000 rows (the PostgREST cap) -------------------------

  maybeIt(
    'counts 1,001 employee jobs exactly: reads past the 1,000-row page',
    async () => {
      const c = await makeCompany(service, 'rp paging', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      const total = 1001;
      const rows = Array.from({ length: total }, (_, i) => ({
        tenant_id: c.tenantId,
        job_number: `BULK-${i}`,
        customer_id: cust,
        technician_id: c.id.admin,
        skill_id: skillId,
        workflow_template_id: templateId,
        workflow_template_version: templateVersion,
        service_location: 'RP bulk',
        scheduled_start: new Date().toISOString(),
        status: 'scheduled',
        created_by: c.id.emp,
      }));
      for (let i = 0; i < total; i += 500) {
        const { error } = await service
          .from('jobs')
          .insert(rows.slice(i, i + 500));
        expect(error).toBeNull();
      }

      const owner = await reports.ownerReport(
        who(c, 'admin', Role.COMPANY_ADMIN),
        {
          from: today(),
          to: today(),
        },
      );
      expect(owner.headline.employeeCreated).toBe(total);
      expect(owner.perEmployee[0]).toMatchObject({
        employeeId: c.id.emp,
        created: total,
      });

      const mine = await reports.employeeReport(who(c, 'emp', Role.EMPLOYEE), {
        from: today(),
        to: today(),
      });
      expect(mine.created.created).toBe(total);
    },
  );

  // ---- Employee report (CAP-9 data) ----------------------------------------

  maybeIt(
    "an employee sees only their own numbers, never a colleague's",
    async () => {
      const c = await makeCompany(service, 'rp emp own', {
        admin: { role: 'company_admin' },
        me: { role: 'employee' },
        other: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      await createJob(c, cust, c.id.me, true);
      await createJob(c, cust, c.id.other, true);
      await createJob(c, cust, c.id.other, false);

      const r = await reports.employeeReport(who(c, 'me', Role.EMPLOYEE), {
        from: today(),
        to: today(),
      });
      expect(r.created).toMatchObject({ created: 1, pending: 1 });
      expect(r.approvalRate).toBeNull(); // no decided job yet
    },
  );

  maybeIt(
    'rejection reasons list only my rejected jobs, newest decision first',
    async () => {
      const c = await makeCompany(service, 'rp emp reasons', {
        admin: { role: 'company_admin' },
        me: { role: 'employee' },
        other: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      const first = await createJob(c, cust, c.id.me, true);
      const second = await createJob(c, cust, c.id.me, true);
      const theirs = await createJob(c, cust, c.id.other, true);
      await decide(c, theirs, 'reject', 'Not mine');
      await decide(c, first, 'reject', 'Duplicate');
      await decide(c, second, 'reject');
      // Make the decision times unambiguous: first decided before second.
      await setJob(first, {
        decided_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      });
      await setJob(second, {
        decided_at: new Date(Date.now() - HOUR_MS).toISOString(),
      });

      const r = await reports.employeeReport(who(c, 'me', Role.EMPLOYEE), {
        from: today(),
        to: today(),
      });
      expect(r.rejectionReasons.map((x) => x.jobId)).toEqual([second, first]);
      expect(r.rejectionReasons[1].reason).toBe('Duplicate');
      expect(r.rejectionReasons[0].reason).toBeNull();
    },
  );

  maybeIt(
    'assigned-now and completed-in-window count only my jobs in the right state',
    async () => {
      const c = await makeCompany(service, 'rp emp work', {
        admin: { role: 'company_admin' },
        me: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      const mineNow = await createJob(c, cust, c.id.admin, false); // assigned to admin
      await setJob(mineNow, { technician_id: c.id.me, status: 'in_progress' });
      const done = await createJob(c, cust, c.id.admin, false);
      await setJob(done, {
        technician_id: c.id.me,
        status: 'completed',
        completed_at: new Date().toISOString(),
      });
      const old = await createJob(c, cust, c.id.admin, false);
      await setJob(old, {
        technician_id: c.id.me,
        status: 'completed',
        completed_at: new Date(Date.now() - 60 * DAY_MS).toISOString(),
      });

      const r = await reports.employeeReport(who(c, 'me', Role.EMPLOYEE), {
        from: daysAgo(30),
        to: today(),
      });
      expect(r.assignedNow).toBe(1);
      expect(r.completedInRange).toBe(1);
    },
  );

  // ---- Approval queue (CAP-10) ---------------------------------------------

  maybeIt(
    'the owner queue lists only pending jobs, oldest submission first',
    async () => {
      const c = await makeCompany(service, 'rp queue order', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      const newer = await createJob(c, cust, c.id.emp, true);
      const older = await createJob(c, cust, c.id.emp, true);
      await setJob(older, {
        created_at: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
      });
      await setJob(newer, {
        created_at: new Date(Date.now() - HOUR_MS).toISOString(),
      });
      const approved = await createJob(c, cust, c.id.emp, true);
      await decide(c, approved, 'approve');
      await createJob(c, cust, c.id.admin, false); // owner job, never queued

      const page = await queue.list(who(c, 'admin', Role.COMPANY_ADMIN), {});
      expect(page.data.map((i) => i.id)).toEqual([older, newer]);
      expect(page.data[0]).toMatchObject({
        employee: { id: c.id.emp },
        ageHours: 5,
      });
      expect(page.hasMore).toBe(false);
    },
  );

  maybeIt('the employee filter and the age filter combine', async () => {
    const c = await makeCompany(service, 'rp queue filters', {
      admin: { role: 'company_admin' },
      e1: { role: 'employee' },
      e2: { role: 'employee' },
    });
    const cust = await createCustomer(c.tenantId);
    const e1Old = await createJob(c, cust, c.id.e1, true);
    await setJob(e1Old, {
      created_at: new Date(Date.now() - 48 * HOUR_MS).toISOString(),
    });
    const e1New = await createJob(c, cust, c.id.e1, true);
    const e2Old = await createJob(c, cust, c.id.e2, true);
    await setJob(e2Old, {
      created_at: new Date(Date.now() - 48 * HOUR_MS).toISOString(),
    });
    const owner = who(c, 'admin', Role.COMPANY_ADMIN);

    const byEmp = await queue.list(owner, { employeeId: c.id.e1 });
    expect(byEmp.data.map((i) => i.id).sort()).toEqual([e1Old, e1New].sort());

    const byAge = await queue.list(owner, { olderThanHours: 24 });
    expect(byAge.data.map((i) => i.id).sort()).toEqual([e1Old, e2Old].sort());

    const both = await queue.list(owner, {
      employeeId: c.id.e1,
      olderThanHours: 24,
    });
    expect(both.data.map((i) => i.id)).toEqual([e1Old]);
  });

  maybeIt(
    'cursor paging returns every pending job once, with no gaps or repeats',
    async () => {
      const c = await makeCompany(service, 'rp queue paging', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push(await createJob(c, cust, c.id.emp, true));
      // Same created_at on two jobs, so the id tie-break is what keeps paging exact.
      const same = new Date(Date.now() - 3 * HOUR_MS).toISOString();
      await setJob(ids[0], { created_at: same });
      await setJob(ids[1], { created_at: same });

      const owner = who(c, 'admin', Role.COMPANY_ADMIN);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await queue.list(owner, { limit: 2, cursor });
        seen.push(...page.data.map((i) => i.id));
        if (!page.hasMore) break;
        cursor = page.nextCursor ?? undefined;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual([...ids].sort());
    },
  );

  maybeIt(
    "an employee's own pending list shows only their pending jobs, never a colleague's",
    async () => {
      const c = await makeCompany(service, 'rp queue mine', {
        admin: { role: 'company_admin' },
        me: { role: 'employee' },
        other: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      const mine = await createJob(c, cust, c.id.me, true);
      await createJob(c, cust, c.id.other, true);
      const decided = await createJob(c, cust, c.id.me, true);
      await decide(c, decided, 'approve');

      const page = await queue.listOwn(who(c, 'me', Role.EMPLOYEE), {});
      expect(page.data.map((i) => i.id)).toEqual([mine]);
    },
  );

  maybeIt(
    'a pending job with no creator still lists, with the employee left blank',
    async () => {
      const c = await makeCompany(service, 'rp queue noname', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const cust = await createCustomer(c.tenantId);
      const job = await createJob(c, cust, c.id.emp, true);
      await setJob(job, { created_by: null });

      const page = await queue.list(who(c, 'admin', Role.COMPANY_ADMIN), {});
      expect(page.data).toEqual([
        expect.objectContaining({ id: job, employee: null }),
      ]);
    },
  );
});
