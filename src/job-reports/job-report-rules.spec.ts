import {
  average,
  countOutcomes,
  creatorKind,
  cumulativeJobFlow,
  median,
  minutesToDecision,
  outcomeOf,
  ownerHeadline,
  ratio,
  sliceWindow,
  workforceAtCuts,
  type MemberFact,
  type ReportJob,
  type WorkforceMembershipRow,
} from './job-report-rules';

const OWNER = 'owner';
const EMP_A = 'emp-a';
const EMP_B = 'emp-b';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const HOURS = (h: number) => new Date(NOW - h * 3600000).toISOString();

const members = new Map<string, MemberFact>([
  [
    OWNER,
    {
      role: 'company_admin',
      name: 'Owner',
      canCreateJobs: false,
      status: 'active',
    },
  ],
  [
    EMP_A,
    { role: 'employee', name: 'Asha', canCreateJobs: true, status: 'active' },
  ],
  [
    EMP_B,
    { role: 'employee', name: 'Ravi', canCreateJobs: false, status: 'removed' },
  ],
  [
    'emp-c',
    { role: 'employee', name: 'Meena', canCreateJobs: true, status: 'active' },
  ],
  [
    'viewer',
    { role: 'viewer', name: 'V', canCreateJobs: false, status: 'active' },
  ],
]);

let n = 0;
function job(p: Partial<ReportJob> & { createdBy: string | null }): ReportJob {
  n += 1;
  return {
    id: `job-${n}`,
    jobNumber: `JB-2026-${String(n).padStart(4, '0')}`,
    status: 'scheduled',
    createdAt: HOURS(1),
    decidedAt: null,
    rejectionReason: null,
    ...p,
  };
}

describe('creatorKind: owner or employee', () => {
  it('no creator (old row) is an owner job', () => {
    expect(creatorKind(null, members)).toBe('owner');
  });
  it('a company admin is an owner job', () => {
    expect(creatorKind(OWNER, members)).toBe('owner');
  });
  it('an active, removed or disabled employee is an employee job', () => {
    expect(creatorKind(EMP_A, members)).toBe('employee');
    expect(creatorKind(EMP_B, members)).toBe('employee');
  });
  it('a creator with no membership (platform admin) counts as owner', () => {
    expect(creatorKind('platform-admin', members)).toBe('owner');
  });
});

describe('outcomeOf: the four employee-job outcomes', () => {
  it('pending, rejected, approved and auto-approved are told apart', () => {
    expect(
      outcomeOf(job({ createdBy: EMP_A, status: 'pending_approval' })),
    ).toBe('pending');
    expect(
      outcomeOf(
        job({ createdBy: EMP_A, status: 'rejected', decidedAt: HOURS(0) }),
      ),
    ).toBe('rejected');
    expect(
      outcomeOf(
        job({ createdBy: EMP_A, status: 'scheduled', decidedAt: HOURS(0) }),
      ),
    ).toBe('approved');
    expect(outcomeOf(job({ createdBy: EMP_A, status: 'scheduled' }))).toBe(
      'auto_approved',
    );
  });
  it('a completed job stays approved', () => {
    expect(
      outcomeOf(
        job({ createdBy: EMP_A, status: 'completed', decidedAt: HOURS(0) }),
      ),
    ).toBe('approved');
  });
  it('a cancelled job is its own bucket, whether it was pending or approved', () => {
    expect(
      outcomeOf(
        job({ createdBy: EMP_A, status: 'cancelled', decidedAt: HOURS(0) }),
      ),
    ).toBe('cancelled');
    expect(outcomeOf(job({ createdBy: EMP_A, status: 'cancelled' }))).toBe(
      'cancelled',
    );
  });
});

describe('counts add up', () => {
  it('pending + rejected + approved + auto equals the total, for any mix', () => {
    const jobs = [
      job({ createdBy: EMP_A, status: 'pending_approval' }),
      job({ createdBy: EMP_A, status: 'pending_approval' }),
      job({ createdBy: EMP_A, status: 'rejected', decidedAt: HOURS(1) }),
      job({ createdBy: EMP_A, status: 'scheduled', decidedAt: HOURS(1) }),
      job({ createdBy: EMP_A, status: 'scheduled' }),
    ];
    const c = countOutcomes(jobs);
    expect(c).toEqual({
      created: 5,
      pending: 2,
      rejected: 1,
      approved: 1,
      autoApproved: 1,
      cancelled: 0,
    });
    expect(
      c.pending + c.rejected + c.approved + c.autoApproved + c.cancelled,
    ).toBe(c.created);
  });
  it('an empty window reports zeros, not nulls', () => {
    expect(countOutcomes([])).toEqual({
      created: 0,
      pending: 0,
      rejected: 0,
      approved: 0,
      autoApproved: 0,
      cancelled: 0,
    });
  });
});

describe('ownerHeadline: the four required counts', () => {
  it('splits owner-created from employee-created, and employee into approved and auto', () => {
    const jobs = [
      job({ createdBy: EMP_A, status: 'scheduled', decidedAt: HOURS(1) }),
      job({ createdBy: EMP_A, status: 'scheduled' }),
      job({ createdBy: EMP_A, status: 'pending_approval' }),
      job({ createdBy: null, status: 'scheduled' }),
      job({ createdBy: OWNER, status: 'scheduled' }),
    ];
    expect(ownerHeadline(jobs, members)).toEqual({
      employeeCreated: 3,
      employeeApproved: 1,
      employeeAutoApproved: 1,
      ownerCreated: 2,
    });
  });
});

describe('ratio and medians: the edge cases', () => {
  it('approval rate is null when nothing needed a decision (no divide by zero)', () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(2, 3)).toBe(0.6667);
  });
  it('median of an even and odd count, and null for none', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 3])).toBe(2);
    expect(median([9, 1, 5])).toBe(5);
  });
  it('average of none is null, not NaN', () => {
    expect(average([])).toBeNull();
    expect(average([1, 2])).toBe(1.5);
  });
});

describe('minutesToDecision: submission to decision', () => {
  it('runs from job creation to the decision', () => {
    const j = job({
      createdBy: EMP_A,
      status: 'scheduled',
      createdAt: HOURS(2),
      decidedAt: HOURS(1),
    });
    expect(minutesToDecision(j)).toBe(60);
  });
  it('a job with no decision has no minutes', () => {
    expect(
      minutesToDecision(job({ createdBy: EMP_A, status: 'pending_approval' })),
    ).toBeNull();
  });
});

describe('sliceWindow: the charts\' shared slicing', () => {
  it('cuts a 30-day window into five equal six-day slices, oldest first', () => {
    expect(sliceWindow('2026-10-14', '2026-11-12', 5)).toEqual([
      { from: '2026-10-14', to: '2026-10-19' },
      { from: '2026-10-20', to: '2026-10-25' },
      { from: '2026-10-26', to: '2026-10-31' },
      { from: '2026-11-01', to: '2026-11-06' },
      { from: '2026-11-07', to: '2026-11-12' },
    ]);
  });
  it('an uneven span makes the last slice shorter, never past `to`', () => {
    const slices = sliceWindow('2026-11-01', '2026-11-07', 3);
    expect(slices).toEqual([
      { from: '2026-11-01', to: '2026-11-03' },
      { from: '2026-11-04', to: '2026-11-06' },
      { from: '2026-11-07', to: '2026-11-07' },
    ]);
  });
  it('a one-day window is one slice that starts and ends on the day', () => {
    expect(sliceWindow('2026-11-12', '2026-11-12', 5)).toEqual([
      { from: '2026-11-12', to: '2026-11-12' },
    ]);
  });
});

describe('cumulativeJobFlow: the headline accumulating to each cut', () => {
  it('counts are cumulative at each cut, same split as the headline', () => {
    const cuts = [
      new Date('2026-11-11T06:30:00Z'),
      new Date('2026-11-12T06:30:00Z'),
    ];
    const before = job({
      createdBy: EMP_A,
      status: 'scheduled',
      createdAt: '2026-11-10T10:00:00Z',
    });
    const approvedBefore = job({
      createdBy: EMP_A,
      status: 'scheduled',
      decidedAt: '2026-11-10T11:00:00Z',
      createdAt: '2026-11-10T09:00:00Z',
    });
    const ownerJob = job({
      createdBy: null,
      status: 'scheduled',
      createdAt: '2026-11-10T12:00:00Z',
    });
    const secondDay = job({
      createdBy: EMP_A,
      status: 'pending_approval',
      createdAt: '2026-11-11T20:00:00Z',
    });
    const flow = cumulativeJobFlow(
      [before, approvedBefore, ownerJob, secondDay],
      members,
      cuts,
    );
    expect(flow).toEqual([
      {
        employeeCreated: 2,
        employeeApproved: 1,
        employeeAutoApproved: 1,
        ownerCreated: 1,
      },
      {
        employeeCreated: 3,
        employeeApproved: 1,
        employeeAutoApproved: 1,
        ownerCreated: 1,
      },
    ]);
  });
  it('an approval counts only in buckets past its decision, never before it', () => {
    const cuts = [
      new Date('2026-11-11T06:30:00Z'),
      new Date('2026-11-12T06:30:00Z'),
    ];
    const createdEarly = job({
      createdBy: EMP_A,
      status: 'scheduled',
      createdAt: '2026-11-10T09:00:00Z',
      decidedAt: '2026-11-11T20:00:00Z', // after the first cut
    });
    const flow = cumulativeJobFlow([createdEarly], members, cuts);
    // Bucket 1: the job exists but its approval had not happened yet.
    expect(flow[0]).toMatchObject({ employeeCreated: 1, employeeApproved: 0 });
    // Bucket 2: the decision instant is behind the cut — approved now.
    expect(flow[1]).toMatchObject({ employeeCreated: 1, employeeApproved: 1 });
  });

  it('a job created at or after the cut belongs to a later bucket, and past-the-end jobs belong nowhere', () => {
    const cuts = [new Date('2026-11-11T06:30:00Z')];
    const atCut = job({
      createdBy: EMP_A,
      status: 'scheduled',
      createdAt: '2026-11-11T06:30:00Z',
    });
    const longAfter = job({
      createdBy: EMP_A,
      status: 'scheduled',
      createdAt: '2026-12-01T00:00:00Z',
    });
    expect(cumulativeJobFlow([atCut, longAfter], members, cuts)).toEqual([
      {
        employeeCreated: 0,
        employeeApproved: 0,
        employeeAutoApproved: 0,
        ownerCreated: 0,
      },
    ]);
  });
});

describe('workforceAtCuts: the as-of workforce counts', () => {
  const cuts = [
    new Date('2026-11-10T06:30:00Z'),
    new Date('2026-11-12T06:30:00Z'),
  ];
  const membership = (
    createdAt: string,
    status: WorkforceMembershipRow['status'],
    updatedAt = createdAt,
  ): WorkforceMembershipRow => ({ createdAt, status, updatedAt });

  it('total grows from the invite and shrinks on a removal before the cut', () => {
    const memberships = [
      membership('2026-11-01T00:00:00Z', 'active'),
      membership('2026-11-11T00:00:00Z', 'removed', '2026-11-11T08:00:00Z'),
    ];
    const counts = workforceAtCuts(memberships, [], cuts);
    expect(counts[0].totalEmployees).toBe(1);
    // The second member was invited before the second cut but removed
    // before it too — the removal stands in for the missing stamp.
    expect(counts[1].totalEmployees).toBe(1);
  });

  it('active and invited back-project the current status; removed was never active', () => {
    const memberships = [
      membership('2026-11-01T00:00:00Z', 'active'),
      membership('2026-11-01T00:00:00Z', 'invited'),
      membership('2026-11-01T00:00:00Z', 'removed', '2026-11-05T00:00:00Z'),
    ];
    const [first] = workforceAtCuts(memberships, [], cuts);
    expect(first).toMatchObject({
      totalEmployees: 2,
      activeEmployees: 1,
      pendingInvites: 1,
    });
  });

  it('needsApproval never counts a job that never waited — auto-approved or owner-created', () => {
    const memberships = [membership('2026-11-01T00:00:00Z', 'active')];
    const jobs = [
      // Approval off: scheduled at creation, decided_at null for life.
      job({
        createdBy: EMP_A,
        status: 'scheduled',
        createdAt: '2026-11-09T00:00:00Z',
      }),
      // Owner-created: never enters the queue either.
      job({
        createdBy: null,
        status: 'scheduled',
        createdAt: '2026-11-09T00:00:00Z',
      }),
    ];
    const counts = workforceAtCuts(memberships, jobs, cuts);
    for (const c of counts) expect(c.needsApproval).toBe(0);
  });

  it('needsApproval is exact history: pending until decided, cancelled only while waiting', () => {
    const memberships = [membership('2026-11-01T00:00:00Z', 'active')];
    const jobs = [
      job({
        createdBy: EMP_A,
        status: 'pending_approval',
        createdAt: '2026-11-09T00:00:00Z',
      }),
      job({
        createdBy: EMP_A,
        status: 'cancelled',
        decidedAt: '2026-11-11T00:00:00Z',
        createdAt: '2026-11-09T00:00:00Z',
      }),
      job({
        createdBy: EMP_A,
        status: 'pending_approval',
        createdAt: '2026-11-11T12:00:00Z',
      }),
    ];
    const counts = workforceAtCuts(memberships, jobs, cuts);
    // First cut: both early jobs are waiting (the cancelled one had no
    // decision yet), and the third did not exist — 2.
    expect(counts[0].needsApproval).toBe(2);
    // Second cut: the first is still waiting, the cancelled one was decided
    // by then, and the third is waiting — 2.
    expect(counts[1].needsApproval).toBe(2);
  });
});
