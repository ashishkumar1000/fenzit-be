/**
 * advance_workflow_step alert recipients (migrations 20261020000003 + 5) —
 * real DEV database suite. Requirement: every ACTIVE, ENABLED company admin of
 * the job's company is told, except the person who advanced the step; nobody
 * else (disabled, invited or removed admins, employees, viewers, other
 * companies) hears anything.
 *
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import {
  IS_REAL_DB,
  POINTS_AT_LIVE,
  call,
} from '../helpers/member-functions-fixture';
import {
  Company,
  makeCompany,
  teardownSuite,
} from '../helpers/member-functions-company';
import { seedJob } from '../helpers/member-functions-job';
import { serviceRoleClient } from '../helpers/rls-seed';

describe('advance_workflow_step alerts (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    expect(POINTS_AT_LIVE).toBe(false);
    await teardownSuite(service);
  }, 120000);
  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service);
  }, 120000);

  /** Advance the job's first step as `actor`; returns who was notified. */
  const advance = async (c: Company, jobId: string, actor: string) => {
    const r = await call(service, 'advance_workflow_step', {
      p_job_id: jobId,
      p_tenant_id: c.tenantId,
      p_actor_id: actor,
      p_step: 'on_my_way',
      p_new_status: 'in_progress',
      p_expected_current_step: null,
    });
    expect(r.error).toBeNull();
    const { data, error } = await service
      .from('notifications')
      .select('user_id, event_type, job_id, payload')
      .eq('tenant_id', c.tenantId);
    expect(error).toBeNull();
    return data as {
      user_id: string;
      event_type: string;
      job_id: string;
      payload: Record<string, unknown>;
    }[];
  };

  const crew = () =>
    makeCompany(service, 'alerts', {
      admin1: { role: 'company_admin' },
      admin2: { role: 'company_admin' },
      disabledAdmin: { role: 'company_admin', disabled: true },
      invitedAdmin: { role: 'company_admin', status: 'invited' },
      removedAdmin: { role: 'company_admin', status: 'removed' },
      tech: { role: 'employee' },
      viewer: { role: 'viewer' },
    });

  maybeIt(
    'a technician advancing a step notifies both active admins and nobody else',
    async () => {
      const c = await crew();
      const other = await makeCompany(service, 'alerts other', {
        admin: { role: 'company_admin' },
      });
      await service
        .from('users')
        .update({ name: 'MFQA Tech' })
        .eq('id', c.id.tech);
      const job = await seedJob(service, c.tenantId, c.id.tech, c.id.admin1);
      const rows = await advance(c, job.jobId, c.id.tech);
      expect(rows.map((r) => r.user_id).sort()).toEqual(
        [c.id.admin1, c.id.admin2].sort(),
      );
      for (const r of rows) {
        expect(r).toMatchObject({ event_type: 'on_my_way', job_id: job.jobId });
        expect(r.payload).toMatchObject({
          step: 'on_my_way',
          technician_name: 'MFQA Tech',
        });
      }
      const { data: foreign } = await service
        .from('notifications')
        .select('id')
        .eq('user_id', other.id.admin);
      expect(foreign).toEqual([]);
    },
  );

  maybeIt(
    'an admin advancing their own job does not notify themselves, but the other admin hears',
    async () => {
      const c = await crew();
      const job = await seedJob(service, c.tenantId, c.id.admin1, c.id.admin1);
      const rows = await advance(c, job.jobId, c.id.admin1);
      expect(rows.map((r) => r.user_id)).toEqual([c.id.admin2]);
    },
  );

  maybeIt(
    'the only admin advancing the step gets nothing (and the step still advances)',
    async () => {
      const c = await makeCompany(service, 'alerts solo', {
        admin: { role: 'company_admin' },
        tech: { role: 'employee' },
      });
      const job = await seedJob(service, c.tenantId, c.id.tech, c.id.admin);
      expect(await advance(c, job.jobId, c.id.admin)).toEqual([]);
      const { data } = await service
        .from('jobs')
        .select('current_step')
        .eq('id', job.jobId)
        .single();
      expect(data).toEqual({ current_step: 'on_my_way' });
    },
  );

  maybeIt(
    'when the only admin is disabled nobody is notified, yet the technician can still advance',
    async () => {
      const c = await makeCompany(service, 'alerts disabled', {
        admin: { role: 'company_admin', disabled: true },
        tech: { role: 'employee' },
      });
      const job = await seedJob(service, c.tenantId, c.id.tech, c.id.admin);
      expect(await advance(c, job.jobId, c.id.tech)).toEqual([]);
    },
  );

  maybeIt(
    're-enabling a disabled admin brings alerts back for the next step',
    async () => {
      const c = await makeCompany(service, 'alerts reenable', {
        admin: { role: 'company_admin', disabled: true },
        tech: { role: 'employee' },
      });
      await service
        .from('users')
        .update({ disabled: false })
        .eq('id', c.id.admin);
      const job = await seedJob(service, c.tenantId, c.id.tech, c.id.admin);
      expect(
        (await advance(c, job.jobId, c.id.tech)).map((r) => r.user_id),
      ).toEqual([c.id.admin]);
    },
  );
});
