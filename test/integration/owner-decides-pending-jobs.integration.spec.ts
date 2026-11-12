/**
 * decide_pending_job (migration 20261112000003) — real DEV database suite.
 * Each test builds its own throwaway company.
 *
 * Plain English: only the owner of THIS company can approve or reject a job that
 * is waiting for approval. A job takes exactly one decision. Approve makes it the
 * creator's assigned work; reject keeps it out of assigned work but in history,
 * with an optional reason of up to 500 characters. Every decision writes one
 * activity row in the same step.
 *
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import {
  IS_REAL_DB,
  POINTS_AT_LIVE,
  mid,
  randomPhone,
  seedPlatformAdmin,
  call,
  FORBIDDEN,
  NOT_FOUND,
  VALIDATION,
  refusal,
} from '../helpers/member-functions-fixture';
import { makeCompany, teardownSuite } from '../helpers/member-functions-company';
import { serviceRoleClient } from '../helpers/rls-seed';

const PA = mid('e005', 1);
const JOB_NOT_PENDING = { code: 'PT409', hint: 'JOB_NOT_PENDING' };

interface JobOut {
  id: string;
  status: string;
  technician_id: string;
  decided_by: string | null;
  decided_at: string | null;
  rejection_reason: string | null;
}

describe('decide_pending_job: owner approves or rejects (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const maybeEach = IS_REAL_DB && !POINTS_AT_LIVE ? it.each : it.skip.each;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);
  jest.setTimeout(120000);

  let skillId: string;

  const createCustomer = async (tenantId: string) => {
    const { data, error } = await service
      .from('customers')
      .insert({
        tenant_id: tenantId,
        name: 'DP customer',
        country_code: '+91',
        phone_number: randomPhone(),
      })
      .select('id')
      .single<{ id: string }>();
    expect(error).toBeNull();
    return data!.id;
  };

  /** An employee's job waiting for approval (approval switch on). */
  const makePending = async (c: { tenantId: string; id: Record<string, string> }) => {
    const customerId = await createCustomer(c.tenantId);
    const r = await call<JobOut[]>(service, 'create_job_with_log', {
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: c.id.emp,
      p_created_by: c.id.emp,
      p_pending_approval: true,
      p_service_location: 'DP location',
      p_skill_id: skillId,
      p_scheduled_start: new Date().toISOString(),
      p_scheduled_end: null,
      p_description: 'DP job',
      p_priority: 'normal',
      p_notes_for_technician: null,
      p_year: new Date().getUTCFullYear(),
    });
    expect(r.error).toBeNull();
    expect(r.data![0].status).toBe('pending_approval');
    return r.data![0].id;
  };

  const decide = (
    c: { tenantId: string },
    caller: string,
    jobId: string,
    decision: unknown,
    reason?: unknown,
  ) =>
    call<JobOut[]>(service, 'decide_pending_job', {
      p_caller: caller,
      p_tenant_id: c.tenantId,
      p_job_id: jobId,
      p_decision: decision,
      p_reason: reason ?? null,
    });

  const jobRow = async (jobId: string) => {
    const { data, error } = await service
      .from('jobs')
      .select('id, status, technician_id, decided_by, decided_at, rejection_reason')
      .eq('id', jobId)
      .single<JobOut>();
    expect(error).toBeNull();
    return data!;
  };

  const decisionEvents = async (jobId: string) => {
    const { data, error } = await service
      .from('activity_logs')
      .select('event_type, actor_id')
      .eq('job_id', jobId)
      .in('event_type', ['job_approved', 'job_rejected']);
    expect(error).toBeNull();
    return data as Array<{ event_type: string; actor_id: string }>;
  };

  const roster = () => ({
    admin: { role: 'company_admin' as const },
    emp: { role: 'employee' as const },
    viewer: { role: 'viewer' as const },
  });

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    expect(POINTS_AT_LIVE).toBe(false);
    await teardownSuite(service);
    await seedPlatformAdmin(service, PA, randomPhone());
    const { data } = await service
      .from('skills')
      .select('id')
      .eq('is_active', true)
      .limit(1)
      .single<{ id: string }>();
    skillId = data!.id;
  }, 120000);
  // Teardown purges ~30 throwaway companies, one connection each: allow ten minutes.
  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service, [], [PA]);
  }, 600000);

  // ---- Approve and reject: the happy paths ---------------------------------

  maybeIt('approve: job becomes scheduled, owner recorded, activity job_approved', async () => {
    const c = await makeCompany(service, 'dp approve', roster());
    const jobId = await makePending(c);
    const r = await decide(c, c.id.admin, jobId, 'approve');
    expect(r.error).toBeNull();
    expect(r.data![0]).toMatchObject({ status: 'scheduled', decided_by: c.id.admin });
    const row = await jobRow(jobId);
    expect(row.technician_id).toBe(c.id.emp);
    expect(row.decided_at).not.toBeNull();
    expect(await decisionEvents(jobId)).toEqual([
      { event_type: 'job_approved', actor_id: c.id.admin },
    ]);
  });

  maybeIt('reject with a reason: job rejected, reason kept, activity job_rejected', async () => {
    const c = await makeCompany(service, 'dp reject reason', roster());
    const jobId = await makePending(c);
    const r = await decide(c, c.id.admin, jobId, 'reject', 'Customer already served');
    expect(r.error).toBeNull();
    expect(r.data![0]).toMatchObject({
      status: 'rejected',
      rejection_reason: 'Customer already served',
      decided_by: c.id.admin,
    });
    expect(await decisionEvents(jobId)).toEqual([
      { event_type: 'job_rejected', actor_id: c.id.admin },
    ]);
  });

  maybeIt('reject with no reason is allowed: reason stored as null', async () => {
    const c = await makeCompany(service, 'dp reject none', roster());
    const jobId = await makePending(c);
    const r = await decide(c, c.id.admin, jobId, 'reject');
    expect(r.error).toBeNull();
    expect(r.data![0]).toMatchObject({ status: 'rejected', rejection_reason: null });
  });

  maybeIt('a whitespace-only reason counts as no reason', async () => {
    const c = await makeCompany(service, 'dp reason blank', roster());
    const jobId = await makePending(c);
    const r = await decide(c, c.id.admin, jobId, 'reject', '   \n\t ');
    expect(r.error).toBeNull();
    expect(r.data![0].rejection_reason).toBeNull();
  });

  maybeIt('the reason is trimmed before it is stored', async () => {
    const c = await makeCompany(service, 'dp reason trim', roster());
    const jobId = await makePending(c);
    const r = await decide(c, c.id.admin, jobId, 'reject', '  wrong address  ');
    expect(r.data![0].rejection_reason).toBe('wrong address');
  });

  maybeIt('a 500-character reason is accepted (upper boundary)', async () => {
    const c = await makeCompany(service, 'dp reason 500', roster());
    const jobId = await makePending(c);
    const reason = 'x'.repeat(500);
    const r = await decide(c, c.id.admin, jobId, 'reject', reason);
    expect(r.error).toBeNull();
    expect(r.data![0].rejection_reason).toBe(reason);
  });

  maybeIt('501 characters is refused, and the job stays pending with no activity', async () => {
    const c = await makeCompany(service, 'dp reason 501', roster());
    const jobId = await makePending(c);
    const r = await decide(c, c.id.admin, jobId, 'reject', 'x'.repeat(501));
    expect(refusal(r)).toEqual(VALIDATION);
    expect((await jobRow(jobId)).status).toBe('pending_approval');
    expect(await decisionEvents(jobId)).toEqual([]);
  });

  maybeIt('500 characters plus surrounding spaces is accepted once trimmed', async () => {
    const c = await makeCompany(service, 'dp reason padded', roster());
    const jobId = await makePending(c);
    const r = await decide(c, c.id.admin, jobId, 'reject', `  ${'x'.repeat(500)}  `);
    expect(r.error).toBeNull();
    expect(r.data![0].rejection_reason).toHaveLength(500);
  });

  // ---- Decision value validation -------------------------------------------

  maybeEach([
    ['an unknown word', 'bogus'],
    ['an empty string', ''],
    ['the wrong case', 'APPROVE'],
    ['null', null],
  ])('a decision of %s is refused and changes nothing', async (_label, decision) => {
    const c = await makeCompany(service, `dp bad decision ${String(decision)}`, roster());
    const jobId = await makePending(c);
    const r = await decide(c, c.id.admin, jobId, decision);
    expect(refusal(r)).toEqual(VALIDATION);
    expect((await jobRow(jobId)).status).toBe('pending_approval');
    expect(await decisionEvents(jobId)).toEqual([]);
  });

  // ---- Who may decide -------------------------------------------------------

  maybeIt('an employee cannot approve their own job', async () => {
    const c = await makeCompany(service, 'dp emp refused', roster());
    const jobId = await makePending(c);
    const r = await decide(c, c.id.emp, jobId, 'approve');
    expect(refusal(r)).toEqual(FORBIDDEN);
    expect((await jobRow(jobId)).status).toBe('pending_approval');
    expect(await decisionEvents(jobId)).toEqual([]);
  });

  maybeIt('a viewer cannot decide a job', async () => {
    const c = await makeCompany(service, 'dp viewer refused', roster());
    const jobId = await makePending(c);
    const r = await decide(c, c.id.viewer, jobId, 'reject');
    expect(refusal(r)).toEqual(FORBIDDEN);
    expect((await jobRow(jobId)).status).toBe('pending_approval');
  });

  maybeIt('a platform admin cannot decide a company job (no membership)', async () => {
    const c = await makeCompany(service, 'dp platform refused', roster());
    const jobId = await makePending(c);
    const r = await decide(c, PA, jobId, 'approve');
    expect(refusal(r)).toEqual(FORBIDDEN);
    expect((await jobRow(jobId)).status).toBe('pending_approval');
  });

  maybeIt('an invited (not yet active) owner cannot decide', async () => {
    const c = await makeCompany(service, 'dp invited owner', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
      pending_owner: { role: 'company_admin', status: 'invited' },
    });
    const jobId = await makePending(c);
    const r = await decide(c, c.id.pending_owner, jobId, 'approve');
    expect(refusal(r)).toEqual(FORBIDDEN);
    expect((await jobRow(jobId)).status).toBe('pending_approval');
  });

  maybeIt('a disabled owner cannot decide', async () => {
    const c = await makeCompany(service, 'dp disabled owner', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
      gone_owner: { role: 'company_admin', disabled: true },
    });
    const jobId = await makePending(c);
    const r = await decide(c, c.id.gone_owner, jobId, 'approve');
    expect(refusal(r)).toEqual(FORBIDDEN);
    expect((await jobRow(jobId)).status).toBe('pending_approval');
  });

  maybeIt('an owner of another company cannot decide this company job', async () => {
    const target = await makeCompany(service, 'dp target co', roster());
    const other = await makeCompany(service, 'dp other co', roster());
    const jobId = await makePending(target);
    const r = await decide(
      { tenantId: target.tenantId },
      other.id.admin,
      jobId,
      'approve',
    );
    expect(refusal(r)).toEqual(FORBIDDEN);
    expect((await jobRow(jobId)).status).toBe('pending_approval');
  });

  maybeIt('an owner cannot reach another company job by naming their own company', async () => {
    const target = await makeCompany(service, 'dp cross target', roster());
    const own = await makeCompany(service, 'dp cross own', roster());
    const jobId = await makePending(target);
    const r = await decide(own, own.id.admin, jobId, 'approve');
    expect(refusal(r)).toEqual(NOT_FOUND);
    expect((await jobRow(jobId)).status).toBe('pending_approval');
  });

  maybeIt('an unknown job id is not found', async () => {
    const c = await makeCompany(service, 'dp unknown job', roster());
    const r = await decide(c, c.id.admin, mid('e005', 99), 'approve');
    expect(refusal(r)).toEqual(NOT_FOUND);
  });

  // ---- One decision per job -------------------------------------------------

  maybeEach([
    ['approve then approve', 'approve', 'approve'],
    ['approve then reject', 'approve', 'reject'],
    ['reject then approve', 'reject', 'approve'],
    ['reject then reject', 'reject', 'reject'],
  ])('a second decision after %s is a conflict and keeps the first', async (_l, first, second) => {
    const c = await makeCompany(service, `dp second ${first} ${second}`, roster());
    const jobId = await makePending(c);
    expect((await decide(c, c.id.admin, jobId, first, 'first reason')).error).toBeNull();
    const before = await jobRow(jobId);
    const again = await decide(c, c.id.admin, jobId, second, 'second reason');
    expect(refusal(again)).toEqual(JOB_NOT_PENDING);
    expect(await jobRow(jobId)).toEqual(before);
    expect(await decisionEvents(jobId)).toHaveLength(1);
  });

  maybeIt('a scheduled job (approval was off) cannot be approved again', async () => {
    const c = await makeCompany(service, 'dp not pending', roster());
    const customerId = await createCustomer(c.tenantId);
    const made = await call<JobOut[]>(service, 'create_job_with_log', {
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: c.id.admin,
      p_service_location: 'DP location',
      p_skill_id: skillId,
      p_scheduled_start: new Date().toISOString(),
      p_scheduled_end: null,
      p_description: 'DP scheduled',
      p_priority: 'normal',
      p_notes_for_technician: null,
      p_year: new Date().getUTCFullYear(),
    });
    const r = await decide(c, c.id.admin, made.data![0].id, 'reject');
    expect(refusal(r)).toEqual(JOB_NOT_PENDING);
    expect((await jobRow(made.data![0].id)).status).toBe('scheduled');
  });

  maybeIt('a race: approve and reject at once, exactly one wins', async () => {
    const c = await makeCompany(service, 'dp race mixed', roster());
    const jobId = await makePending(c);
    const [a, b] = await Promise.all([
      decide(c, c.id.admin, jobId, 'approve'),
      decide(c, c.id.admin, jobId, 'reject', 'raced'),
    ]);
    const results = [a, b];
    const winners = results.filter((r) => r.error === null);
    const losers = results.filter((r) => r.error !== null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(refusal(losers[0])).toEqual(JOB_NOT_PENDING);
    const row = await jobRow(jobId);
    expect(row.status).toBe(winners[0].data![0].status);
    expect(await decisionEvents(jobId)).toHaveLength(1);
  });

  maybeIt('a race: five owner approvals at once, one decision recorded', async () => {
    const c = await makeCompany(service, 'dp race five', roster());
    const jobId = await makePending(c);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => decide(c, c.id.admin, jobId, 'approve')),
    );
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(
      results.filter((r) => r.error !== null).every((r) => refusal(r).hint === 'JOB_NOT_PENDING'),
    ).toBe(true);
    expect(await decisionEvents(jobId)).toHaveLength(1);
  });

  // ---- Table rules that back the function ----------------------------------

  maybeIt('a rejected job with no decider is refused by the table', async () => {
    const c = await makeCompany(service, 'dp constraint decider', roster());
    const jobId = await makePending(c);
    const bad = await service.from('jobs').update({ status: 'rejected' }).eq('id', jobId);
    expect(bad.error?.code).toBe('23514');
    expect((await jobRow(jobId)).status).toBe('pending_approval');
  });

  maybeIt('a rejected job with a decider and time is accepted by the table', async () => {
    const c = await makeCompany(service, 'dp constraint ok', roster());
    const jobId = await makePending(c);
    const ok = await service
      .from('jobs')
      .update({ status: 'rejected', decided_by: c.id.admin, decided_at: new Date().toISOString() })
      .eq('id', jobId);
    expect(ok.error).toBeNull();
  });

  maybeIt('the table refuses an empty or over-long stored reason', async () => {
    const c = await makeCompany(service, 'dp constraint reason', roster());
    const jobId = await makePending(c);
    const empty = await service.from('jobs').update({ rejection_reason: '' }).eq('id', jobId);
    expect(empty.error?.code).toBe('23514');
    const long = await service
      .from('jobs')
      .update({ rejection_reason: 'x'.repeat(501) })
      .eq('id', jobId);
    expect(long.error?.code).toBe('23514');
  });

  maybeIt('a rejected job keeps its creator as technician (history, CAP-7)', async () => {
    const c = await makeCompany(service, 'dp history keeps', roster());
    const jobId = await makePending(c);
    await decide(c, c.id.admin, jobId, 'reject', 'no');
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: 'rejected', technician_id: c.id.emp });
  });
});
