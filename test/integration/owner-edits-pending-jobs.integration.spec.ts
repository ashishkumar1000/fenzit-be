/**
 * update_job_with_log, story 4 (migration 20261112000004) — real DEV database suite.
 * Each test builds its own throwaway company.
 *
 * Plain English: the owner can fix a pending job (times, notes, priority,
 * description) or cancel it, but the job stays with its creator until approved.
 * Scheduled jobs keep their edits. Every real change writes one job_edited row with
 * before and after values. A save that changes nothing writes nothing. Rejected,
 * cancelled and completed jobs are read-only.
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
  refusal,
  REFUSED,
} from '../helpers/member-functions-fixture';
import { makeCompany, teardownSuite } from '../helpers/member-functions-company';
import { serviceRoleClient } from '../helpers/rls-seed';

const PA = mid('e006', 1);
const JOB_NOT_MODIFIABLE = REFUSED('PT409', 'JOB_NOT_MODIFIABLE');
const PENDING_LOCKED = REFUSED('PT422', 'PENDING_ASSIGNEE_LOCKED');
const INVERTED = { code: 'PT422', hint: null };

interface JobOut {
  id: string;
  status: string;
  technician_id: string;
  description: string | null;
  scheduled_start: string;
  scheduled_end: string | null;
  notes_for_technician: string | null;
  priority: string;
  decided_by: string | null;
  decided_at: string | null;
  updated_at: string;
}

interface Edit {
  p_cancel?: boolean;
  p_description?: string | null;
  p_scheduled_start?: string | null;
  p_scheduled_end?: string | null;
  p_notes_for_technician?: string | null;
  p_technician_id?: string | null;
  p_priority?: string | null;
}

describe('update_job_with_log: owner edits and cancels (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);
  jest.setTimeout(120000);

  let skillId: string;
  const START = '2026-06-22T09:30:00.000Z';
  const LATER = '2026-06-23T09:30:00.000Z';

  const createCustomer = async (tenantId: string) => {
    const { data, error } = await service
      .from('customers')
      .insert({
        tenant_id: tenantId,
        name: 'OE customer',
        country_code: '+91',
        phone_number: randomPhone(),
      })
      .select('id')
      .single<{ id: string }>();
    expect(error).toBeNull();
    return data!.id;
  };

  const createJob = async (
    c: { tenantId: string; id: Record<string, string> },
    pending: boolean,
  ) => {
    const customerId = await createCustomer(c.tenantId);
    const r = await call<JobOut[]>(service, 'create_job_with_log', {
      p_tenant_id: c.tenantId,
      p_customer_id: customerId,
      p_technician_id: c.id.emp,
      p_actor_id: pending ? c.id.emp : c.id.admin,
      p_created_by: pending ? c.id.emp : null,
      p_pending_approval: pending,
      p_service_location: 'OE location',
      p_skill_id: skillId,
      p_scheduled_start: START,
      p_scheduled_end: null,
      p_description: 'OE job',
      p_priority: 'normal',
      p_notes_for_technician: 'original notes',
      p_year: new Date().getUTCFullYear(),
    });
    expect(r.error).toBeNull();
    return r.data![0].id;
  };

  const editJob = (
    c: { tenantId: string; id: Record<string, string> },
    jobId: string,
    edit: Edit,
    actor: string = c.id.admin,
  ) =>
    call<JobOut[]>(service, 'update_job_with_log', {
      p_job_id: jobId,
      p_tenant_id: c.tenantId,
      p_actor_id: actor,
      p_cancel: false,
      p_description: null,
      p_scheduled_start: null,
      p_scheduled_end: null,
      p_notes_for_technician: null,
      p_technician_id: null,
      p_priority: null,
      ...edit,
    });

  const cancelJob = (
    c: { tenantId: string; id: Record<string, string> },
    jobId: string,
  ) =>
    call<JobOut[]>(service, 'update_job_with_log', {
      p_job_id: jobId,
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

  const jobRow = async (jobId: string) => {
    const { data, error } = await service
      .from('jobs')
      .select(
        'id, status, technician_id, description, scheduled_start, scheduled_end, notes_for_technician, priority, decided_by, decided_at, updated_at',
      )
      .eq('id', jobId)
      .single<JobOut>();
    expect(error).toBeNull();
    return data!;
  };

  const events = async (jobId: string) => {
    const { data, error } = await service
      .from('activity_logs')
      .select('event_type, actor_id, metadata')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });
    expect(error).toBeNull();
    return data as Array<{
      event_type: string;
      actor_id: string;
      metadata: Record<string, unknown> | null;
    }>;
  };

  const roster = () => ({
    admin: { role: 'company_admin' as const },
    emp: { role: 'employee' as const },
    emp2: { role: 'employee' as const },
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

  // ---- Pending jobs: the owner may edit and cancel -------------------------

  maybeIt('a pending job: a description edit is saved and logged with before and after', async () => {
    const c = await makeCompany(service, 'oe pend desc', roster());
    const jobId = await createJob(c, true);
    const r = await editJob(c, jobId, { p_description: 'Fixed wording' });
    expect(r.error).toBeNull();
    expect(r.data![0]).toMatchObject({ status: 'pending_approval', description: 'Fixed wording' });
    const ev = await events(jobId);
    const edits = ev.filter((e) => e.event_type === 'job_edited');
    expect(edits).toHaveLength(1);
    expect(edits[0].actor_id).toBe(c.id.admin);
    expect(edits[0].metadata).toEqual({
      changes: { description: { before: 'OE job', after: 'Fixed wording' } },
    });
  });

  maybeIt('a pending job: times, notes and priority change in one save, one log row lists all three', async () => {
    const c = await makeCompany(service, 'oe pend many', roster());
    const jobId = await createJob(c, true);
    const r = await editJob(c, jobId, {
      p_scheduled_start: LATER,
      p_notes_for_technician: 'Bring ladder',
      p_priority: 'urgent',
    });
    expect(r.error).toBeNull();
    const ev = (await events(jobId)).filter((e) => e.event_type === 'job_edited');
    expect(ev).toHaveLength(1);
    const changes = (ev[0].metadata as { changes: Record<string, unknown> }).changes;
    expect(Object.keys(changes).sort()).toEqual(
      ['notesForTechnician', 'priority', 'scheduledStart'],
    );
    expect(changes.priority).toEqual({ before: 'normal', after: 'urgent' });
    expect(changes.notesForTechnician).toEqual({
      before: 'original notes',
      after: 'Bring ladder',
    });
  });

  maybeIt('a pending job: a save that repeats the stored values writes nothing and does not touch updated_at', async () => {
    const c = await makeCompany(service, 'oe pend noop', roster());
    const jobId = await createJob(c, true);
    const before = await jobRow(jobId);
    const r = await editJob(c, jobId, {
      p_description: 'OE job',
      p_priority: 'normal',
      p_technician_id: c.id.emp,
    });
    expect(r.error).toBeNull();
    const after = await jobRow(jobId);
    expect(after.updated_at).toBe(before.updated_at);
    expect((await events(jobId)).some((e) => e.event_type === 'job_edited')).toBe(false);
  });

  maybeIt('a pending job: an empty patch (all nulls) leaves the row exactly as it was', async () => {
    const c = await makeCompany(service, 'oe pend empty', roster());
    const jobId = await createJob(c, true);
    const before = await jobRow(jobId);
    const r = await editJob(c, jobId, {});
    expect(r.error).toBeNull();
    const after = await jobRow(jobId);
    expect(after).toEqual(before);
  });

  maybeIt('a pending job: the assignee cannot be changed, and nothing is written', async () => {
    const c = await makeCompany(service, 'oe pend lock', roster());
    const jobId = await createJob(c, true);
    const before = await jobRow(jobId);
    const r = await editJob(c, jobId, { p_technician_id: c.id.emp2, p_priority: 'urgent' });
    expect(refusal(r)).toEqual(PENDING_LOCKED);
    const after = await jobRow(jobId);
    expect(after).toEqual(before);
    expect(await events(jobId)).toHaveLength(1);
  });

  maybeIt('a pending job: a cancel ends it as cancelled, owner recorded as decider', async () => {
    const c = await makeCompany(service, 'oe pend cancel', roster());
    const jobId = await createJob(c, true);
    const r = await cancelJob(c, jobId);
    expect(r.error).toBeNull();
    expect(r.data![0]).toMatchObject({ status: 'cancelled', decided_by: c.id.admin });
    const row = await jobRow(jobId);
    expect(row.decided_at).not.toBeNull();
    const ev = await events(jobId);
    expect(ev.map((e) => e.event_type)).toEqual(['job_submitted', 'job_cancelled']);
  });

  maybeIt('a cancelled pending job cannot be edited or cancelled again', async () => {
    const c = await makeCompany(service, 'oe pend recancel', roster());
    const jobId = await createJob(c, true);
    await cancelJob(c, jobId);
    expect(refusal(await editJob(c, jobId, { p_priority: 'urgent' }))).toEqual(
      JOB_NOT_MODIFIABLE,
    );
    expect(refusal(await cancelJob(c, jobId))).toEqual(JOB_NOT_MODIFIABLE);
  });

  // ---- Refused states: a rejected job can never be revived ------------------

  maybeIt('a rejected job refuses any edit and stays rejected', async () => {
    const c = await makeCompany(service, 'oe rejected', roster());
    const jobId = await createJob(c, true);
    await call(service, 'decide_pending_job', {
      p_caller: c.id.admin,
      p_tenant_id: c.tenantId,
      p_job_id: jobId,
      p_decision: 'reject',
      p_reason: 'No',
    });
    const before = await jobRow(jobId);
    const r = await editJob(c, jobId, { p_description: 'Revive?', p_priority: 'urgent' });
    expect(refusal(r)).toEqual(JOB_NOT_MODIFIABLE);
    const after = await jobRow(jobId);
    expect(after).toEqual(before);
    expect(after.status).toBe('rejected');
  });

  maybeIt('a rejected job refuses a cancel too', async () => {
    const c = await makeCompany(service, 'oe rejected cancel', roster());
    const jobId = await createJob(c, true);
    await call(service, 'decide_pending_job', {
      p_caller: c.id.admin,
      p_tenant_id: c.tenantId,
      p_job_id: jobId,
      p_decision: 'reject',
    });
    expect(refusal(await cancelJob(c, jobId))).toEqual(JOB_NOT_MODIFIABLE);
  });

  maybeIt('an approved job (now scheduled) can be edited again', async () => {
    const c = await makeCompany(service, 'oe approved', roster());
    const jobId = await createJob(c, true);
    await call(service, 'decide_pending_job', {
      p_caller: c.id.admin,
      p_tenant_id: c.tenantId,
      p_job_id: jobId,
      p_decision: 'approve',
    });
    const r = await editJob(c, jobId, { p_priority: 'urgent' });
    expect(r.error).toBeNull();
    expect(r.data![0]).toMatchObject({ status: 'scheduled', priority: 'urgent' });
  });

  maybeIt('an edit made before a decision is logged before it: submitted, edited, rejected', async () => {
    const c = await makeCompany(service, 'oe edit then decide', roster());
    const jobId = await createJob(c, true);
    const edited = await editJob(c, jobId, { p_priority: 'urgent' });
    expect(edited.error).toBeNull();
    const decided = await call(service, 'decide_pending_job', {
      p_caller: c.id.admin,
      p_tenant_id: c.tenantId,
      p_job_id: jobId,
      p_decision: 'reject',
    });
    expect(decided.error).toBeNull();
    const ev = (await events(jobId)).map((e) => e.event_type);
    expect(ev).toEqual(['job_submitted', 'job_edited', 'job_rejected']);
  });

  // ---- Scheduled jobs: edits keep working, now with the audit trail ---------

  maybeIt('a scheduled job: an edit is saved and logged with before and after', async () => {
    const c = await makeCompany(service, 'oe sched edit', roster());
    const jobId = await createJob(c, false);
    const r = await editJob(c, jobId, { p_notes_for_technician: 'Ring twice' });
    expect(r.error).toBeNull();
    expect(r.data![0]).toMatchObject({ status: 'scheduled', notes_for_technician: 'Ring twice' });
    const edits = (await events(jobId)).filter((e) => e.event_type === 'job_edited');
    expect(edits).toHaveLength(1);
    expect(edits[0].metadata).toEqual({
      changes: {
        notesForTechnician: { before: 'original notes', after: 'Ring twice' },
      },
    });
  });

  maybeIt('a scheduled job: reassigning writes job_edited (technicianId) and the job_reassigned row', async () => {
    const c = await makeCompany(service, 'oe sched reassign', roster());
    const jobId = await createJob(c, false);
    const r = await editJob(c, jobId, { p_technician_id: c.id.emp2 });
    expect(r.error).toBeNull();
    expect(r.data![0].technician_id).toBe(c.id.emp2);
    const ev = await events(jobId);
    expect(ev.map((e) => e.event_type)).toEqual([
      'job_created',
      'job_edited',
      'job_reassigned',
    ]);
    expect(ev[1].metadata).toEqual({
      changes: {
        technicianId: { before: c.id.emp, after: c.id.emp2 },
      },
    });
    expect(ev[2].metadata).toEqual({
      previousTechnicianId: c.id.emp,
      newTechnicianId: c.id.emp2,
    });
  });

  maybeIt('a scheduled job: a scheduled_end before the start is refused and nothing is written', async () => {
    const c = await makeCompany(service, 'oe sched window', roster());
    const jobId = await createJob(c, false);
    const before = await jobRow(jobId);
    const r = await editJob(c, jobId, {
      p_scheduled_end: '2026-06-01T00:00:00.000Z',
    });
    expect(refusal(r)).toEqual(INVERTED);
    expect(await jobRow(jobId)).toEqual(before);
    expect((await events(jobId)).some((e) => e.event_type === 'job_edited')).toBe(false);
  });

  maybeIt('a scheduled job: a cancel still works and records no decider', async () => {
    const c = await makeCompany(service, 'oe sched cancel', roster());
    const jobId = await createJob(c, false);
    const r = await cancelJob(c, jobId);
    expect(r.error).toBeNull();
    expect(r.data![0]).toMatchObject({ status: 'cancelled', decided_by: null });
    expect((await events(jobId)).map((e) => e.event_type)).toEqual([
      'job_created',
      'job_cancelled',
    ]);
  });

  // ---- Concurrency and tenant isolation ------------------------------------

  maybeIt('parallel edits to one pending job: each save lands once, and every change is logged', async () => {
    const c = await makeCompany(service, 'oe race', roster());
    const jobId = await createJob(c, true);
    const results = await Promise.all([
      editJob(c, jobId, { p_priority: 'urgent' }),
      editJob(c, jobId, { p_notes_for_technician: 'Gate code 42' }),
      editJob(c, jobId, { p_description: 'Race wording' }),
      editJob(c, jobId, { p_scheduled_start: LATER }),
    ]);
    for (const r of results) expect(r.error).toBeNull();
    const edits = (await events(jobId)).filter((e) => e.event_type === 'job_edited');
    expect(edits).toHaveLength(4);
    const changed = edits.flatMap((e) =>
      Object.keys((e.metadata as { changes: object }).changes),
    );
    expect(changed.sort()).toEqual(
      ['description', 'notesForTechnician', 'priority', 'scheduledStart'],
    );
  });

  maybeIt('an edit racing a decision: the job ends in one consistent state, never half-edited', async () => {
    const c = await makeCompany(service, 'oe race decide', roster());
    const jobId = await createJob(c, true);
    const [edit, decide] = await Promise.all([
      editJob(c, jobId, { p_priority: 'urgent' }),
      call(service, 'decide_pending_job', {
        p_caller: c.id.admin,
        p_tenant_id: c.tenantId,
        p_job_id: jobId,
        p_decision: 'approve',
      }),
    ]);
    // Either order is legal, and an approved job is scheduled, which still takes
    // edits. So the edit is never lost, whichever row lock runs first.
    expect(decide.error).toBeNull();
    expect(edit.error).toBeNull();
    const row = await jobRow(jobId);
    expect(row.status).toBe('scheduled');
    expect(row.priority).toBe('urgent');
    const types = (await events(jobId)).map((e) => e.event_type);
    expect(types).toEqual(
      expect.arrayContaining(['job_submitted', 'job_approved', 'job_edited']),
    );
    expect(types).toHaveLength(3);
  });

  maybeIt("another company's owner cannot edit the job: no row returned, nothing written", async () => {
    const mine = await makeCompany(service, 'oe tenant a', roster());
    const theirs = await makeCompany(service, 'oe tenant b', roster());
    const jobId = await createJob(theirs, true);
    const before = await jobRow(jobId);
    const r = await editJob(mine, jobId, { p_priority: 'urgent' });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([]);
    expect(await jobRow(jobId)).toEqual(before);
    expect(await events(jobId)).toHaveLength(1);
  });
});
