/**
 * Story 5 pending-job alerts (CAP-4, CAP-6) — real DEV database suite.
 * Each test builds its own throwaway company. The RPCs are the existing story 2–4
 * ones; the alerts are NestJS writes made right after each one commits.
 *
 * Plain English: an employee's pending job alerts the owners when it is sent in.
 * The owner's approve, reject, cancel or real edit alerts the employee who created
 * it, one row per event. A save that changes nothing writes no alert. Each alert
 * is addressed to one user, so only that user can read it.
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
} from '../helpers/member-functions-fixture';
import {
  makeCompany,
  teardownSuite,
} from '../helpers/member-functions-company';
import { serviceRoleClient } from '../helpers/rls-seed';
import {
  alertCreatorOfCancel,
  alertCreatorOfDecision,
  alertCreatorOfEdit,
  alertOwnersOfSubmission,
  changedEditFields,
  PENDING_JOB_EVENT,
  type JobBeforeUpdate,
} from '../../src/jobs/pending-job-notifications';
import type { UpdateJobDto } from '../../src/jobs/dto/update-job.dto';

const PA = mid('e005', 2);

interface JobOut extends JobBeforeUpdate {
  decided_by: string | null;
  rejection_reason: string | null;
}

interface NoteOut {
  user_id: string;
  job_id: string;
  event_type: string;
  payload: Record<string, unknown>;
}

describe('pending-job alerts: who hears about each step (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);
  jest.setTimeout(120000);

  let skillId: string;

  const createCustomer = async (tenantId: string) => {
    const { data, error } = await service
      .from('customers')
      .insert({
        tenant_id: tenantId,
        name: 'PJA customer',
        country_code: '+91',
        phone_number: randomPhone(),
      })
      .select('id')
      .single<{ id: string }>();
    expect(error).toBeNull();
    return data!.id;
  };

  /** Employee sends a job in: the same RPC call story 2 makes. */
  const submitPending = async (c: {
    tenantId: string;
    id: Record<string, string>;
  }) => {
    const customerId = await createCustomer(c.tenantId);
    const r = await call<JobOut[]>(service, 'create_job_with_log', {
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: c.id.emp,
      p_created_by: c.id.emp,
      p_pending_approval: true,
      p_service_location: 'PJA location',
      p_skill_id: skillId,
      p_scheduled_start: new Date().toISOString(),
      p_scheduled_end: null,
      p_description: 'PJA job',
      p_priority: 'normal',
      p_notes_for_technician: null,
      p_year: new Date().getUTCFullYear(),
    });
    expect(r.error).toBeNull();
    expect(r.data![0].status).toBe('pending_approval');
    return r.data![0];
  };

  const jobRow = async (jobId: string) => {
    const { data, error } = await service
      .from('jobs')
      .select(
        'id, tenant_id, job_number, customer_id, created_by, status, technician_id, description, scheduled_start, scheduled_end, notes_for_technician, priority, decided_by, rejection_reason',
      )
      .eq('id', jobId)
      .single<JobOut>();
    expect(error).toBeNull();
    return data!;
  };

  /** Every notification for one job, read back with the service role. */
  const notesFor = async (jobId: string) => {
    const { data, error } = await service
      .from('notifications')
      .select('user_id, job_id, event_type, payload')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });
    expect(error).toBeNull();
    return data as NoteOut[];
  };

  const roster = () => ({
    admin: { role: 'company_admin' as const },
    admin2: { role: 'company_admin' as const },
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
  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service, [], [PA]);
  }, 600000);

  // ---- Submission -----------------------------------------------------------

  maybeIt(
    'submit: every active owner gets one job.submitted, the viewer and employee get none',
    async () => {
      const c = await makeCompany(service, 'pja submit', roster());
      const job = await submitPending(c);
      await alertOwnersOfSubmission(service, job, c.id.emp);

      const notes = await notesFor(job.id);
      expect(notes.map((n) => n.user_id).sort()).toEqual(
        [c.id.admin, c.id.admin2].sort(),
      );
      expect(new Set(notes.map((n) => n.event_type))).toEqual(
        new Set([PENDING_JOB_EVENT.SUBMITTED]),
      );
      expect(notes[0].payload).toMatchObject({
        job_number: job.job_number,
        customer_name: 'PJA customer',
      });
      // Owner-only read: the employee's own feed holds no row for this job.
      const { data: empFeed } = await service
        .from('notifications')
        .select('id')
        .eq('user_id', c.id.emp)
        .eq('job_id', job.id);
      expect(empFeed).toEqual([]);
    },
  );

  // ---- Decision -------------------------------------------------------------

  maybeIt(
    'approve: the employee gets one job.approved and the owner gets nothing',
    async () => {
      const c = await makeCompany(service, 'pja approve', roster());
      const job = await submitPending(c);
      const r = await call<JobOut[]>(service, 'decide_pending_job', {
        p_caller: c.id.admin,
        p_tenant_id: c.tenantId,
        p_job_id: job.id,
        p_decision: 'approve',
        p_reason: null,
      });
      expect(r.error).toBeNull();
      await alertCreatorOfDecision(
        service,
        r.data![0],
        c.id.admin,
        'approve',
        null,
      );

      const notes = await notesFor(job.id);
      expect(notes).toEqual([
        expect.objectContaining({
          user_id: c.id.emp,
          event_type: PENDING_JOB_EVENT.APPROVED,
        }),
      ]);
    },
  );

  maybeIt(
    'reject with a reason: the employee gets one job.rejected carrying the reason',
    async () => {
      const c = await makeCompany(service, 'pja reject', roster());
      const job = await submitPending(c);
      const r = await call<JobOut[]>(service, 'decide_pending_job', {
        p_caller: c.id.admin,
        p_tenant_id: c.tenantId,
        p_job_id: job.id,
        p_decision: 'reject',
        p_reason: 'Customer already served',
      });
      expect(r.error).toBeNull();
      await alertCreatorOfDecision(
        service,
        r.data![0],
        c.id.admin,
        'reject',
        'Customer already served',
      );

      const notes = await notesFor(job.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        user_id: c.id.emp,
        event_type: PENDING_JOB_EVENT.REJECTED,
        payload: { reason: 'Customer already served' },
      });
    },
  );

  // ---- Owner cancel and edit ------------------------------------------------

  maybeIt(
    'owner cancels a pending job: the employee gets one job.cancelled',
    async () => {
      const c = await makeCompany(service, 'pja cancel', roster());
      const job = await submitPending(c);
      const r = await call<JobOut[]>(service, 'update_job_with_log', {
        p_job_id: job.id,
        p_tenant_id: c.tenantId,
        p_actor_id: c.id.admin,
        p_cancel: true,
        p_description: null,
        p_scheduled_start: null,
        p_scheduled_end: null,
        p_notes_for_technician: null,
        p_technician_id: null,
        p_priority: null,
      });
      expect(r.error).toBeNull();
      await alertCreatorOfCancel(service, r.data![0], c.id.admin);

      const notes = await notesFor(job.id);
      expect(notes).toEqual([
        expect.objectContaining({
          user_id: c.id.emp,
          event_type: PENDING_JOB_EVENT.CANCELLED,
        }),
      ]);
    },
  );

  maybeIt(
    'owner edits a pending job: one job.edited listing only the real change',
    async () => {
      const c = await makeCompany(service, 'pja edit', roster());
      const job = await submitPending(c);
      const before = await jobRow(job.id);
      const dto = { priority: 'urgent' } as UpdateJobDto;
      const r = await call<JobOut[]>(service, 'update_job_with_log', {
        p_job_id: job.id,
        p_tenant_id: c.tenantId,
        p_actor_id: c.id.admin,
        p_cancel: false,
        p_description: null,
        p_scheduled_start: null,
        p_scheduled_end: null,
        p_notes_for_technician: null,
        p_technician_id: null,
        p_priority: 'urgent',
      });
      expect(r.error).toBeNull();
      await alertCreatorOfEdit(
        service,
        r.data![0],
        c.id.admin,
        changedEditFields(before, dto),
      );

      const notes = await notesFor(job.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        user_id: c.id.emp,
        event_type: PENDING_JOB_EVENT.EDITED,
        payload: { changed_fields: ['priority'] },
      });
    },
  );

  maybeIt(
    'owner saves the same priority again: the database writes nothing, so no alert',
    async () => {
      const c = await makeCompany(service, 'pja noop', roster());
      const job = await submitPending(c);
      const before = await jobRow(job.id);
      const dto = { priority: 'normal' } as UpdateJobDto;
      const r = await call<JobOut[]>(service, 'update_job_with_log', {
        p_job_id: job.id,
        p_tenant_id: c.tenantId,
        p_actor_id: c.id.admin,
        p_cancel: false,
        p_description: null,
        p_scheduled_start: null,
        p_scheduled_end: null,
        p_notes_for_technician: null,
        p_technician_id: null,
        p_priority: 'normal',
      });
      expect(r.error).toBeNull();
      await alertCreatorOfEdit(
        service,
        r.data![0],
        c.id.admin,
        changedEditFields(before, dto),
      );

      expect(await notesFor(job.id)).toEqual([]);
    },
  );

  maybeIt(
    'a second decision on the same job: refused, and no second alert is sent',
    async () => {
      const c = await makeCompany(service, 'pja twice', roster());
      const job = await submitPending(c);
      const first = await call<JobOut[]>(service, 'decide_pending_job', {
        p_caller: c.id.admin,
        p_tenant_id: c.tenantId,
        p_job_id: job.id,
        p_decision: 'approve',
        p_reason: null,
      });
      expect(first.error).toBeNull();
      await alertCreatorOfDecision(
        service,
        first.data![0],
        c.id.admin,
        'approve',
        null,
      );

      const second = await call<JobOut[]>(service, 'decide_pending_job', {
        p_caller: c.id.admin2,
        p_tenant_id: c.tenantId,
        p_job_id: job.id,
        p_decision: 'reject',
        p_reason: 'too late',
      });
      expect(second.error).not.toBeNull();
      // The alert runs only after a successful RPC, so the refused decision adds nothing.
      expect(await notesFor(job.id)).toHaveLength(1);
    },
  );
});
