import {
  average,
  countOutcomes,
  creatorKind,
  employeesWithPermissionNoJobs,
  median,
  minutesToDecision,
  outcomeOf,
  ownerHeadline,
  ownerPipeline,
  perEmployee,
  ratio,
  type MemberFact,
  type ReportJob,
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
      outcomeOf(job({ createdBy: EMP_A, status: 'completed', decidedAt: HOURS(0) })),
    ).toBe('approved');
  });
  it('a cancelled job is its own bucket, whether it was pending or approved', () => {
    expect(
      outcomeOf(job({ createdBy: EMP_A, status: 'cancelled', decidedAt: HOURS(0) })),
    ).toBe('cancelled');
    expect(outcomeOf(job({ createdBy: EMP_A, status: 'cancelled' }))).toBe('cancelled');
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

describe('ownerPipeline', () => {
  it('pending over 24h uses the strict boundary: exactly 24h is not over', () => {
    const exactly = job({
      createdBy: EMP_A,
      status: 'pending_approval',
      createdAt: HOURS(24),
    });
    const over = job({
      createdBy: EMP_A,
      status: 'pending_approval',
      createdAt: HOURS(25),
    });
    const fresh = job({
      createdBy: EMP_A,
      status: 'pending_approval',
      createdAt: HOURS(1),
    });
    const p = ownerPipeline([exactly, over, fresh], NOW);
    expect(p.pending).toBe(3);
    expect(p.pendingOverOneDay).toBe(1);
  });
  it('rejected splits into with and without a reason', () => {
    const p = ownerPipeline(
      [
        job({
          createdBy: EMP_A,
          status: 'rejected',
          decidedAt: HOURS(1),
          rejectionReason: 'Duplicate',
        }),
        job({ createdBy: EMP_A, status: 'rejected', decidedAt: HOURS(1) }),
      ],
      NOW,
    );
    expect(p).toMatchObject({
      rejected: 2,
      rejectedWithReason: 1,
      rejectedWithoutReason: 1,
    });
  });
  it('approval rate counts only jobs that needed approval', () => {
    const p = ownerPipeline(
      [
        job({ createdBy: EMP_A, status: 'scheduled', decidedAt: HOURS(1) }),
        job({ createdBy: EMP_A, status: 'rejected', decidedAt: HOURS(1) }),
        job({ createdBy: EMP_A, status: 'scheduled' }), // auto: not in the rate
      ],
      NOW,
    );
    expect(p.approvalRate).toBe(0.5);
  });
  it('oldest pending is the earliest submission, and null when none is pending', () => {
    const newer = job({
      createdBy: EMP_A,
      status: 'pending_approval',
      createdAt: HOURS(2),
    });
    const older = job({
      createdBy: EMP_A,
      status: 'pending_approval',
      createdAt: HOURS(30),
    });
    expect(ownerPipeline([newer, older], NOW).oldestPending).toMatchObject({
      id: older.id,
      submittedAt: older.createdAt,
    });
    expect(ownerPipeline([], NOW).oldestPending).toBeNull();
  });
});

describe('perEmployee and employees with permission but no jobs', () => {
  it('one row per creator, with shares that add to the employee total, sorted by volume', () => {
    const rows = perEmployee(
      [
        job({ createdBy: EMP_A, status: 'scheduled' }),
        job({ createdBy: EMP_A, status: 'scheduled' }),
        job({ createdBy: 'emp-c', status: 'pending_approval' }),
      ],
      members,
    );
    expect(rows.map((r) => [r.name, r.created])).toEqual([
      ['Asha', 2],
      ['Meena', 1],
    ]);
    expect(rows[0].shareOfEmployeeCreated).toBeCloseTo(0.6667, 4);
    expect(rows[1].pending).toBe(1);
  });
  it('lists only active employees with creation on and no job in the window', () => {
    const none = employeesWithPermissionNoJobs(members, new Set([EMP_A]));
    expect(none).toEqual([{ employeeId: 'emp-c', name: 'Meena' }]);
  });
  it('a removed employee with creation on is not listed as a candidate', () => {
    const map = new Map(members);
    map.set('emp-x', {
      role: 'employee',
      name: 'Gone',
      canCreateJobs: true,
      status: 'removed',
    });
    expect(employeesWithPermissionNoJobs(map, new Set())).not.toContainEqual(
      expect.objectContaining({ employeeId: 'emp-x' }),
    );
  });
});
