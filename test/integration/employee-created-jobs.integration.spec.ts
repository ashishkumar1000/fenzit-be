/**
 * create_job_with_log with employee-created jobs (migration 20261112000002) —
 * real DEV database suite. Each test builds its own throwaway company.
 *
 * Plain English: a job is saved as 'pending_approval' only when the caller says
 * so. The creator is stored on every job. Pending jobs still get an activity
 * row ('job_submitted'), and approved-by-default jobs get 'job_created'. Old
 * 12-input callers keep working as owner-created jobs.
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
  membershipIn,
} from '../helpers/member-functions-fixture';
import { makeCompany, teardownSuite } from '../helpers/member-functions-company';
import { serviceRoleClient } from '../helpers/rls-seed';

const PA = mid('e004', 1);

interface JobOut {
  id: string;
  status: string;
  technician_id: string;
  created_by: string | null;
  tenant_id: string;
}

describe('create_job_with_log: employee-created jobs (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);
  jest.setTimeout(120000);

  let skillId: string;

  const createCustomer = async (tenantId: string) => {
    const { data, error } = await service
      .from('customers')
      .insert({
        tenant_id: tenantId,
        name: 'EC customer',
        country_code: '+91',
        phone_number: randomPhone(),
      })
      .select('id')
      .single<{ id: string }>();
    expect(error).toBeNull();
    return data!.id;
  };

  const rpc = (args: Record<string, unknown>) =>
    call<JobOut[]>(service, 'create_job_with_log', {
      p_service_location: 'EC location',
      p_skill_id: skillId,
      p_scheduled_start: new Date().toISOString(),
      p_scheduled_end: null,
      p_description: 'EC job',
      p_priority: 'normal',
      p_notes_for_technician: null,
      p_year: new Date().getUTCFullYear(),
      ...args,
    });

  const activityFor = async (jobId: string) => {
    const { data, error } = await service
      .from('activity_logs')
      .select('event_type, actor_id')
      .eq('job_id', jobId);
    expect(error).toBeNull();
    return data as Array<{ event_type: string; actor_id: string }>;
  };

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
  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service, [], [PA]);
  }, 120000);

  maybeIt('an old 12-input call still makes an owner job: scheduled, creator = actor', async () => {
    const c = await makeCompany(service, 'ec legacy', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    const customerId = await createCustomer(c.tenantId);
    const r = await rpc({
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: c.id.admin,
    });
    expect(r.error).toBeNull();
    const job = r.data![0];
    expect(job).toMatchObject({ status: 'scheduled', created_by: c.id.admin });
    expect((await activityFor(job.id)).map((a) => a.event_type)).toEqual(['job_created']);
  });

  maybeIt('an owner-created job records the owner as creator', async () => {
    const c = await makeCompany(service, 'ec owner', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    const customerId = await createCustomer(c.tenantId);
    const r = await rpc({
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: c.id.admin,
      p_created_by: c.id.admin,
      p_pending_approval: false,
    });
    expect(r.error).toBeNull();
    expect(r.data![0]).toMatchObject({ status: 'scheduled', created_by: c.id.admin });
  });

  maybeIt(
    'approval on: pending_approval, assigned to the creator, activity job_submitted',
    async () => {
      const c = await makeCompany(service, 'ec pending', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const customerId = await createCustomer(c.tenantId);
      const r = await rpc({
        p_tenant_id: c.tenantId,
        p_customer_id: customerId,
        p_technician_id: c.id.emp,
        p_actor_id: c.id.emp,
        p_created_by: c.id.emp,
        p_pending_approval: true,
      });
      expect(r.error).toBeNull();
      const job = r.data![0];
      expect(job).toMatchObject({
        status: 'pending_approval',
        technician_id: c.id.emp,
        created_by: c.id.emp,
        tenant_id: c.tenantId,
      });
      expect((await activityFor(job.id)).map((a) => a.event_type)).toEqual(['job_submitted']);
    },
  );

  maybeIt('approval off: scheduled at once, creator recorded, activity job_created', async () => {
    const c = await makeCompany(service, 'ec auto', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    const customerId = await createCustomer(c.tenantId);
    const r = await rpc({
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: c.id.emp,
      p_created_by: c.id.emp,
      p_pending_approval: false,
    });
    expect(r.error).toBeNull();
    expect(r.data![0]).toMatchObject({ status: 'scheduled', created_by: c.id.emp });
    expect((await activityFor(r.data![0].id)).map((a) => a.event_type)).toEqual(['job_created']);
  });

  maybeIt('a pending job is not returned by a scheduled-only read (CAP-4)', async () => {
    const c = await makeCompany(service, 'ec not scheduled', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    const customerId = await createCustomer(c.tenantId);
    const pending = await rpc({
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: c.id.emp,
      p_created_by: c.id.emp,
      p_pending_approval: true,
    });
    const { data } = await service
      .from('jobs')
      .select('id')
      .eq('technician_id', c.id.emp)
      .eq('status', 'scheduled');
    expect((data as Array<{ id: string }>).map((j) => j.id)).not.toContain(
      pending.data![0].id,
    );
  });

  maybeIt('the creator must be a real user: an unknown creator is refused', async () => {
    const c = await makeCompany(service, 'ec fk', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    const customerId = await createCustomer(c.tenantId);
    const r = await rpc({
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: c.id.admin,
      p_created_by: mid('e004', 99),
      p_pending_approval: true,
    });
    expect(r.error?.code).toBe('23503');
  });

  maybeIt('the status check refuses an unknown status, and accepts pending_approval', async () => {
    const c = await makeCompany(service, 'ec status check', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    const customerId = await createCustomer(c.tenantId);
    const r = await rpc({
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: c.id.admin,
    });
    const jobId = r.data![0].id;
    const bad = await service.from('jobs').update({ status: 'bogus' }).eq('id', jobId);
    expect(bad.error?.code).toBe('23514');
    const ok = await service
      .from('jobs')
      .update({ status: 'pending_approval' })
      .eq('id', jobId);
    expect(ok.error).toBeNull();
  });

  maybeIt('the employee membership used for the job is not changed by job creation', async () => {
    const c = await makeCompany(service, 'ec membership untouched', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    const customerId = await createCustomer(c.tenantId);
    const before = await membershipIn(service, c.id.emp, c.tenantId);
    await rpc({
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: c.id.emp,
      p_created_by: c.id.emp,
      p_pending_approval: true,
    });
    expect(await membershipIn(service, c.id.emp, c.tenantId)).toEqual(before);
  });
});
