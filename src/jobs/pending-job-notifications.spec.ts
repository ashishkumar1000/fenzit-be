import { PENDING_JOB_EVENT } from './pending-job-notifications';
import {
  alertCreatorOfCancel,
  alertCreatorOfDecision,
  alertCreatorOfEdit,
  alertOwnersOfSubmission,
  changedEditFields,
  type JobBeforeUpdate,
} from './pending-job-notifications';
import { pushCopyForEvent, PUSH_CHANNEL } from '../push/push-copy';
import { JobPriority } from './enums/job-priority.enum';

/**
 * Story 5 helpers (CAP-4, CAP-6): who gets which alert, and what counts as a
 * real change. Unit level: the database is a small fake that records inserts.
 *
 * Plain English: each owner submission, decision and real pending-job edit makes
 * exactly one alert for the right person. A save that changes nothing makes none.
 * Nobody is alerted about their own action, and a failed alert never throws.
 */

const TENANT = 'tenant-1';
const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
const EMPLOYEE = 'emp-1';
const JOB_ID = '11111111-1111-4111-8111-111111111111';

interface Table {
  data?: unknown;
  error?: unknown;
  insertError?: unknown;
}

/** Records every insert; reads answer from `tables` by table name. */
function fakeAdmin(
  tables: Record<string, Table>,
  inserts: Array<{ table: string; rows: Array<Record<string, unknown>> }>,
) {
  const node = (table: string) => {
    const res = tables[table] ?? { data: null, error: null };
    const n: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'in', 'is']) {
      n[m] = () => n;
    }
    n['maybeSingle'] = () =>
      Promise.resolve({ data: res.data, error: res.error });
    n['returns'] = () => Promise.resolve({ data: res.data, error: res.error });
    n['insert'] = (rows: Array<Record<string, unknown>>) => {
      inserts.push({ table, rows });
      return Promise.resolve({ data: null, error: res.insertError ?? null });
    };
    return n;
  };
  return { from: (table: string) => node(table) } as never;
}

const owners = [{ user_id: OWNER_A }, { user_id: OWNER_B }];
const job = {
  id: JOB_ID,
  tenant_id: TENANT,
  job_number: 'JB-2026-0007',
  customer_id: 'cust-1',
  created_by: EMPLOYEE,
};

describe('changedEditFields: what a save really changes', () => {
  const before: JobBeforeUpdate = {
    ...job,
    status: 'pending_approval',
    technician_id: EMPLOYEE,
    description: 'Fix pump',
    scheduled_start: '2026-06-22T09:30:00Z',
    scheduled_end: null,
    notes_for_technician: null,
    priority: JobPriority.NORMAL,
  };

  it('an empty patch changes nothing', () => {
    expect(changedEditFields(before, {})).toEqual([]);
  });

  it('a value equal to the stored one is not a change', () => {
    expect(
      changedEditFields(before, {
        description: 'Fix pump',
        priority: JobPriority.NORMAL,
      }),
    ).toEqual([]);
  });

  it('the same instant written in another time zone is not a change', () => {
    expect(
      changedEditFields(before, {
        scheduledStart: '2026-06-22T15:00:00+05:30',
      }),
    ).toEqual([]);
  });

  it('a real change to each editable field is listed by its activity-log name', () => {
    expect(
      changedEditFields(before, {
        description: 'Replace seal',
        scheduledStart: '2026-06-23T10:00:00Z',
        scheduledEnd: '2026-06-23T12:00:00Z',
        notesForTechnician: 'Bring ladder',
        priority: JobPriority.URGENT,
      }),
    ).toEqual([
      'description',
      'scheduledStart',
      'scheduledEnd',
      'notesForTechnician',
      'priority',
    ]);
  });

  it('setting an end time on a job that had none is a change', () => {
    expect(
      changedEditFields(before, {
        scheduledEnd: '2026-06-22T11:00:00Z',
      }),
    ).toEqual(['scheduledEnd']);
  });

  it('an empty note on a job that had no note is still a change (the database agrees)', () => {
    expect(changedEditFields(before, { notesForTechnician: '' })).toEqual([
      'notesForTechnician',
    ]);
  });

  it('an explicit null is "keep the current value" to the database, so it is not a change', () => {
    expect(
      changedEditFields(before, {
        description: null,
        scheduledEnd: null,
        notesForTechnician: null,
      } as never),
    ).toEqual([]);
  });

  it('a field the request did not send is never listed', () => {
    expect(
      changedEditFields(before, {
        priority: JobPriority.URGENT,
      }),
    ).toEqual(['priority']);
  });
});

describe('alertOwnersOfSubmission (job.submitted)', () => {
  it('one alert per active owner, never to the employee who submitted', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    const admin = fakeAdmin(
      {
        memberships: { data: owners },
        customers: { data: { name: 'Asha Traders' } },
        users: { data: { name: 'Ravi' } },
      },
      inserts,
    );

    await alertOwnersOfSubmission(admin, job, EMPLOYEE);

    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('notifications');
    expect(inserts[0].rows.map((r) => r.user_id)).toEqual([OWNER_A, OWNER_B]);
    expect(inserts[0].rows[0]).toMatchObject({
      tenant_id: TENANT,
      job_id: JOB_ID,
      event_type: PENDING_JOB_EVENT.SUBMITTED,
      payload: {
        job_number: 'JB-2026-0007',
        customer_name: 'Asha Traders',
        employee_name: 'Ravi',
      },
    });
  });

  it('a company with no active owner writes nothing', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await alertOwnersOfSubmission(
      fakeAdmin({ memberships: { data: [] } }, inserts),
      job,
      EMPLOYEE,
    );
    expect(inserts).toHaveLength(0);
  });

  it('a failed owner read is dropped, never thrown to the caller', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await expect(
      alertOwnersOfSubmission(
        fakeAdmin({ memberships: { error: { message: 'boom' } } }, inserts),
        job,
        EMPLOYEE,
      ),
    ).resolves.toBeUndefined();
    expect(inserts).toHaveLength(0);
  });

  it('a failed insert is dropped, never thrown to the caller', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await expect(
      alertOwnersOfSubmission(
        fakeAdmin(
          {
            memberships: { data: owners, insertError: { message: 'boom' } },
            customers: { data: null },
            users: { data: null },
          },
          inserts,
        ),
        job,
        EMPLOYEE,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('alertCreatorOfDecision (job.approved / job.rejected)', () => {
  it('approve: the creator gets one job.approved alert', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await alertCreatorOfDecision(
      fakeAdmin({ customers: { data: { name: 'Asha' } } }, inserts),
      job,
      OWNER_A,
      'approve',
      null,
    );
    expect(inserts[0].rows).toEqual([
      expect.objectContaining({
        user_id: EMPLOYEE,
        event_type: PENDING_JOB_EVENT.APPROVED,
        payload: {
          job_number: 'JB-2026-0007',
          customer_name: 'Asha',
          reason: null,
        },
      }),
    ]);
  });

  it('reject with a reason: the creator gets job.rejected carrying the reason', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await alertCreatorOfDecision(
      fakeAdmin({ customers: { data: { name: 'Asha' } } }, inserts),
      job,
      OWNER_A,
      'reject',
      'Duplicate of JB-2026-0006',
    );
    expect(inserts[0].rows[0]).toMatchObject({
      event_type: PENDING_JOB_EVENT.REJECTED,
      payload: { reason: 'Duplicate of JB-2026-0006' },
    });
  });

  it('no creator on the job: nothing is written', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await alertCreatorOfDecision(
      fakeAdmin({}, inserts),
      { ...job, created_by: null },
      OWNER_A,
      'approve',
      null,
    );
    expect(inserts).toHaveLength(0);
  });

  it('the owner decided on their own job: nobody is alerted about their own action', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await alertCreatorOfDecision(
      fakeAdmin({}, inserts),
      { ...job, created_by: OWNER_A },
      OWNER_A,
      'approve',
      null,
    );
    expect(inserts).toHaveLength(0);
  });
});

describe('alertCreatorOfCancel (job.cancelled)', () => {
  it('the creator gets one job.cancelled alert', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await alertCreatorOfCancel(fakeAdmin({}, inserts), job, OWNER_A);
    expect(inserts[0].rows[0]).toMatchObject({
      user_id: EMPLOYEE,
      event_type: PENDING_JOB_EVENT.CANCELLED,
    });
  });

  it('the creator cancelled their own pending job: no alert', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await alertCreatorOfCancel(fakeAdmin({}, inserts), job, EMPLOYEE);
    expect(inserts).toHaveLength(0);
  });
});

describe('alertCreatorOfEdit (job.edited)', () => {
  it('one save with real changes: one job.edited alert listing the changed fields', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await alertCreatorOfEdit(
      fakeAdmin({ customers: { data: { name: 'Asha' } } }, inserts),
      job,
      OWNER_A,
      ['description', 'priority'],
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0].rows[0]).toMatchObject({
      user_id: EMPLOYEE,
      event_type: PENDING_JOB_EVENT.EDITED,
      payload: {
        job_number: 'JB-2026-0007',
        customer_name: 'Asha',
        changed_fields: ['description', 'priority'],
      },
    });
  });

  it('a save with no real change: no alert', async () => {
    const inserts: Array<{
      table: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    await alertCreatorOfEdit(fakeAdmin({}, inserts), job, OWNER_A, []);
    expect(inserts).toHaveLength(0);
  });
});

describe('push copy for the job approval events', () => {
  const events = [
    PENDING_JOB_EVENT.SUBMITTED,
    PENDING_JOB_EVENT.APPROVED,
    PENDING_JOB_EVENT.REJECTED,
    PENDING_JOB_EVENT.CANCELLED,
    PENDING_JOB_EVENT.EDITED,
  ];

  it.each(events)(
    '%s: jobs channel, public, names the job, never says Technician',
    (event) => {
      const copy = pushCopyForEvent(event, {
        job_number: 'JB-2026-0007',
        customer_name: 'Asha',
        employee_name: 'Ravi',
      });
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body).toContain('JB-2026-0007');
      expect(copy.channel).toBe(PUSH_CHANNEL.jobs);
      expect(copy.visibility).toBe('PUBLIC');
      expect(`${copy.title} ${copy.body}`).not.toMatch(/technician/i);
    },
  );

  it('a job.* event with a bare payload still gets a title, not the workflow-step wording', () => {
    const copy = pushCopyForEvent(PENDING_JOB_EVENT.APPROVED, {});
    expect(copy.title).toBe('Job approved');
  });
});
