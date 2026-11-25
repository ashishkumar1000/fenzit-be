import { describe, expect, test } from 'bun:test';
import { EXPECTED_EDGES, checkSchemaDrift, companyPlan, personPlan, reviewedRequestCount } from './purge';
import type { Db } from './db';

/**
 * The purge plans are the dangerous core of the tool: one wrong step and
 * the transaction dies on a RESTRICT foreign key mid-delete (the rollback
 * protects data, but the purge fails exactly when it is needed). These
 * tests pin the invariant without a database:
 *  - every child deletes before the row it references, for every snapshot
 *    edge where both tables are in the plan (the Happy-Hoye purges passed
 *    on lucky data — this check does not depend on luck);
 *  - the snapshot itself stays sorted, unique and well-formed;
 *  - every `where` clause only references params the step actually binds;
 *  - the tenants row is deleted by id, never by the tenant_id column that
 *    does not exist on it (the byTenant regression).
 */

const parseEdge = (edge: string) => {
  const [src = '', cols = '', ref = '', deltype = ''] = edge.split('|');
  return { src, cols, ref, deltype };
};

function expectChildrenFirst(label: string, plan: ReturnType<typeof personPlan>): void {
  // Tables appear more than once (own-tenant + cross-tenant twins) — EVERY
  // copy of the child must precede EVERY copy of its parent.
  const at = new Map<string, number[]>();
  plan.forEach((step, i) => {
    at.set(step.table, [...(at.get(step.table) ?? []), i]);
  });
  for (const edge of EXPECTED_EDGES) {
    const { src, ref } = parseEdge(edge);
    const srcAll = at.get(src);
    const refAll = at.get(ref);
    if (!srcAll || !refAll) continue;
    if (Math.max(...srcAll) >= Math.min(...refAll)) {
      throw new Error(
        `${label}: ${src} (steps ${srcAll.join(',')}) not fully before ${ref} (steps ${refAll.join(',')}) — RESTRICT aborts: ${edge}`,
      );
    }
  }
}

function expectParamsBound(label: string, plan: ReturnType<typeof personPlan>): void {
  for (const step of plan) {
    const highest = [...step.where.matchAll(/\$(\d+)/g)].reduce((m, g) => Math.max(m, Number(g[1])), 0);
    if (highest > step.params.length) {
      throw new Error(`${label}: ${step.table} where references $${highest} but binds ${step.params.length} param(s)`);
    }
  }
}

describe('purge plans', () => {
  test('every FK child deletes before its referenced parent (person plan)', () => {
    expectChildrenFirst('personPlan', personPlan('00000000-0000-0000-0000-000000000001'));
  });

  test('every FK child deletes before its referenced parent (company plan)', () => {
    const plan = companyPlan('00000000-0000-0000-0000-000000000002', [
      '00000000-0000-0000-0000-000000000003',
    ]);
    // The plan has two families (own-tenant and cross-tenant twins of the
    // same tables) — ordering is validated within each family; a row only
    // ever references parents in its own tenant.
    expectChildrenFirst('companyPlan/own', plan.filter((s) => !s.where.includes('tenant_id <> $2')));
    expectChildrenFirst('companyPlan/cross', plan.filter((s) => s.where.includes('tenant_id <> $2')));
  });

  test('company plan deletes members by tenant, then their other-tenant history, then users', () => {
    const plan = companyPlan('t', ['m1', 'm2']);
    const membershipSteps = plan.filter((s) => s.table === 'memberships');
    expect(membershipSteps).toHaveLength(3);
    expect(membershipSteps[0]!.where).toBe('tenant_id = $1');
    expect(membershipSteps[1]!.where).toBe('user_id = ANY($1::uuid[]) and tenant_id <> $2');
    expect(membershipSteps[1]!.params).toEqual([['m1', 'm2'], 't']);
    // Other people's memberships invited by our members are NULLed, not deleted.
    expect(membershipSteps[2]!.where).toBe('invited_by = ANY($1::uuid[])');
    expect(membershipSteps[2]!.updateSet).toBe('invited_by = NULL');
    const usersAt = plan.findIndex((s) => s.table === 'users');
    for (const s of membershipSteps) expect(plan.indexOf(s)).toBeLessThan(usersAt);
    // The FULL cross-tenant family exists (a dropped step passes the order
    // check vacuously because every table also has a byTenant twin).
    const crossTables = [
      'attendance_corrections', 'attendance_day_overrides', 'leave_events', 'leave_request_days',
      'leave_requests', 'attendance_records', 'attendance_attempts', 'attendance_enrolments',
      'attendance_office_assignments', 'attendance_onboarding', 'attendance_weekly_off_overrides',
      'notifications', 'report_requests', 'activity_logs', 'attachment_uploads', 'attachments', 'jobs',
      'invite_sms_audit', 'payroll_month_locks', 'payroll_off_cycle_lines', 'report_queue_pauses',
    ];
    for (const table of crossTables) {
      const step = plan.find((s) => s.table === table && s.where.includes('tenant_id <> $2'));
      expect(step, `cross-tenant step for ${table}`).toBeDefined();
      expect(plan.indexOf(step!)).toBeLessThan(usersAt);
    }
  });

  test('plan steps only reference params they bind', () => {
    expectParamsBound('personPlan', personPlan('00000000-0000-0000-0000-000000000001'));
    expectParamsBound(
      'companyPlan',
      companyPlan('00000000-0000-0000-0000-000000000002', [
        '00000000-0000-0000-0000-000000000003',
      ]),
    );
  });

  test('tenants is deleted by id, not by the non-existent tenant_id column', () => {
    const tenants = companyPlan('t', []).find((s) => s.table === 'tenants');
    expect(tenants).toBeDefined();
    expect(tenants!.where).toBe('id = $1');
    expect(tenants!.params).toEqual(['t']);
  });

  test('the person plan ends at users and starts at audit_log', () => {
    const plan = personPlan('u');
    expect(plan[0]!.table).toBe('audit_log');
    expect(plan.at(-1)!.table).toBe('users');
    expect(plan.at(-1)!.where).toBe('id = $1');
  });

  test('person plan covers the job cascade victims (attachments, uploads, activity) before jobs', () => {
    const plan = personPlan('u');
    const jobsAt = plan.findIndex((s) => s.table === 'jobs');
    expect(jobsAt).toBeGreaterThan(-1);
    for (const table of ['attachment_uploads', 'attachments', 'activity_logs']) {
      const steps = plan.filter((s) => s.table === table);
      expect(steps.length, `${table} appears exactly once (no double backup)`).toBe(1);
      const step = table === 'activity_logs'
        ? steps.find((s) => s.where.includes('job_id'))
        : steps[0];
      expect(step, `${table} must be job-scoped in the person plan`).toBeDefined();
      // The backup scope must match the jobs delete EXACTLY (technician work
      // plus rejected jobs they decided) — a partial revert here would leave
      // the cascade victims of the decided-rejected jobs unbacked.
      expect(step!.where).toContain("(status = 'rejected' and decided_by = $1)");
      expect(plan.indexOf(step!)).toBeLessThan(jobsAt);
    }
    // Notifications to others about the deleted jobs cascade too — same scope.
    const notif = plan.find((s) => s.table === 'notifications');
    expect(notif!.where).toContain("(status = 'rejected' and decided_by = $1)");
  });

  test('person plan covers leave the target CREATED for other employees', () => {
    const plan = personPlan('u');
    for (const table of ['leave_events', 'leave_request_days']) {
      const step = plan.find((s) => s.table === table);
      expect(step, `${table} step exists`).toBeDefined();
      expect(step!.where).toContain('leave_request_id in (select id from public.leave_requests where created_by = $1)');
    }
  });

  test('purging a person never deletes memberships of people they invited', () => {
    const plan = personPlan('u');
    const membershipSteps = plan.filter((s) => s.table === 'memberships');
    const deletes = membershipSteps.filter((s) => !s.updateSet);
    const updates = membershipSteps.filter((s) => s.updateSet);
    // Own memberships are deleted; invited_by references are NULLed so the
    // invited people keep their membership (and the RESTRICT edge stays happy).
    expect(deletes.map((s) => s.where)).toEqual(['user_id = $1']);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.where).toBe('invited_by = $1');
    expect(updates[0]!.updateSet).toBe('invited_by = NULL');
    // The update runs before the users delete (the FK needs it gone first).
    expect(plan.indexOf(updates[0]!)).toBeLessThan(plan.findIndex((s) => s.table === 'users'));
  });
});

describe('EXPECTED_EDGES snapshot hygiene', () => {
  test('every edge is well-formed with a blocking or append delete rule', () => {
    for (const edge of EXPECTED_EDGES) {
      const { src, cols, ref, deltype } = parseEdge(edge);
      expect(edge, `4 pipe-separated parts: ${edge}`).toBe(`${src}|${cols}|${ref}|${deltype}`);
      expect(src.length > 0, edge).toBe(true);
      expect(cols.length > 0, edge).toBe(true);
      expect(ref.length > 0, edge).toBe(true);
      expect(['r', 'a'].includes(deltype), `only RESTRICT/NO-ACTION edges belong here: ${edge}`).toBe(true);
    }
  });

  test('sorted and free of duplicates (the drift check compares against this verbatim)', () => {
    const sorted = [...EXPECTED_EDGES].sort();
    expect(EXPECTED_EDGES).toEqual(sorted);
    expect(new Set(EXPECTED_EDGES).size).toBe(EXPECTED_EDGES.length);
  });

  test('snapshot includes the edges of the 2026-11 tables (account deletion, photo reports, skill requests)', () => {
    for (const edge of [
      'account_deletion_requests|reviewed_by|users|r',
      'account_deletion_requests|user_id|users|r',
      'attachment_reports|reporter_id|users|r',
      'attachment_reports|reviewed_by|users|r',
      'skill_requests|requested_by|users|r',
      'skill_requests|tenant_id|tenants|r',
    ]) {
      expect(EXPECTED_EDGES, edge).toContain(edge);
    }
  });

  test('snapshot includes the edges of the invite-SMS, employee-created-jobs and payroll tables (2026-11-25 drift)', () => {
    for (const edge of [
      'invite_sms_audit|membership_user_id,tenant_id|memberships|r',
      'jobs|created_by|users|r',
      'jobs|decided_by|users|r',
      'payroll_month_locks|locked_by|users|r',
      'payroll_off_cycle_lines|created_by|users|r',
      'report_queue_pauses|paused_by|users|a',
    ]) {
      expect(EXPECTED_EDGES, edge).toContain(edge);
    }
  });

  // The stub-based tests above can only pin self-consistency — a mis-transcribed
  // edge string passes them while the live schema disagrees, and the next real
  // `super purge` aborts on drift again. This probe runs the drift check against
  // the real database (catalog SELECTs only) — opt in with SUPER_LIVE_DRIFT=1:
  //   SUPER_LIVE_DRIFT=1 bun test scripts/super
  test.skipIf(!process.env['SUPER_LIVE_DRIFT'] || !process.env['DATABASE_URL'])(
    'live schema matches the snapshot (catalog read-only; SUPER_LIVE_DRIFT=1)',
    async () => {
      const { makePgDb } = await import('./db');
      const db = makePgDb(process.env['DATABASE_URL']!);
      try {
        expect(await checkSchemaDrift(db)).toEqual([]);
      } finally {
        await db.close();
      }
    },
  );
});

describe('reviewed-request refusal', () => {
  const stubDb = (n: string, seen: unknown[][]) =>
    ({
      query: async (_text: string, params?: unknown[]) => {
        seen.push(params ?? []);
        return { rows: [{ n }], rowCount: 1 };
      },
    }) as unknown as Db;

  test('a person who reviewed any request counts as blocked (sum of both tables)', async () => {
    const seen: unknown[][] = [];
    expect(await reviewedRequestCount(stubDb('2', seen), ['u1'])).toBe(2);
    expect(seen[0]).toEqual([['u1']]);
  });

  test('no reviews means no block', async () => {
    expect(await reviewedRequestCount(stubDb('0', []), ['u1'])).toBe(0);
  });
});

describe('2026-11 tables are purged with their people and company', () => {
  test('person plan removes the person\'s own requests and photo reports before users', () => {
    const plan = personPlan('u');
    const usersAt = plan.findIndex((s) => s.table === 'users');
    const adr = plan.find((s) => s.table === 'account_deletion_requests');
    const sk = plan.find((s) => s.table === 'skill_requests');
    const rep = plan.find((s) => s.table === 'attachment_reports');
    for (const step of [adr, sk, rep]) {
      expect(step).toBeDefined();
      expect(plan.indexOf(step!)).toBeLessThan(usersAt);
    }
    expect(adr!.where).toBe('user_id = $1');
    expect(sk!.where).toBe('requested_by = $1');
    expect(rep!.where).toContain('reporter_id = $1');
    // Reports on the person's job photos go too — they would cascade away silently otherwise.
    expect(rep!.where).toContain('attachment_id in (select id from public.attachments');
    // ...and only on photos of jobs THIS plan deletes (their own work plus
    // rejected jobs they decided), never on the whole platform.
    expect(rep!.where).toContain("job_id in (select id from public.jobs where technician_id = $1 or (status = 'rejected' and decided_by = $1))");
  });

  test('person photo reports are backed up before the job attachments cascade them away', () => {
    const plan = personPlan('u');
    const repAt = plan.findIndex((s) => s.table === 'attachment_reports');
    const attAt = plan.findIndex((s) => s.table === 'attachments');
    expect(repAt).toBeGreaterThan(-1);
    expect(repAt).toBeLessThan(attAt);
  });

  test('company plan: members\' requests go across every company; the company\'s own rows go by tenant', () => {
    const plan = companyPlan('t', ['m1', 'm2']);
    const usersAt = plan.findIndex((s) => s.table === 'users');
    const adr = plan.find((s) => s.table === 'account_deletion_requests');
    expect(adr).toBeDefined();
    expect(adr!.where).toBe('user_id = ANY($1::uuid[])');
    expect(adr!.params).toEqual([['m1', 'm2']]);
    // No tenant_id column on this table, so it must not be given a tenant twin.
    expect(plan.filter((s) => s.table === 'account_deletion_requests')).toHaveLength(1);

    const skOwn = plan.find((s) => s.table === 'skill_requests' && s.where === 'tenant_id = $1');
    const skCross = plan.find((s) => s.table === 'skill_requests' && s.where.includes('tenant_id <> $2'));
    expect(skOwn).toBeDefined();
    expect(skCross).toBeDefined();
    expect(skCross!.params).toEqual([['m1', 'm2'], 't']);

    const repOwn = plan.find((s) => s.table === 'attachment_reports' && s.where === 'tenant_id = $1');
    const repCross = plan.find((s) => s.table === 'attachment_reports' && s.where.includes('tenant_id <> $2'));
    expect(repOwn).toBeDefined();
    expect(repCross).toBeDefined();
    // The cross-tenant step is scoped to the members (reporter, or the photo of a member's job) — never "all other tenants".
    expect(repCross!.where).toContain('reporter_id = ANY($1::uuid[])');
    expect(repCross!.where).toContain('technician_id = ANY($1::uuid[])');
    // ...and its backup scope covers the decided-rejected jobs the plan deletes.
    expect(repCross!.where).toContain("decided_by = ANY($1::uuid[])");
    expect(repCross!.params).toEqual([['m1', 'm2'], 't']);

    // Every new step is gone before users; own-tenant reports go before the
    // tenant's attachments (so the receipt counts them rather than a cascade).
    for (const step of [adr, skOwn, skCross, repOwn, repCross]) {
      expect(plan.indexOf(step!)).toBeLessThan(usersAt);
    }
    const attOwnAt = plan.findIndex((s) => s.table === 'attachments' && s.where === 'tenant_id = $1');
    expect(attOwnAt).toBeGreaterThan(-1);
    expect(plan.indexOf(repOwn!)).toBeLessThan(attOwnAt);
  });
});

describe('2026-11-25 drift tables (invite SMS audit, job authorship, payroll locks, queue pauses)', () => {
  test('person plan deletes the rows that pin memberships/users and NULLs the preserveable links', () => {
    const plan = personPlan('u');
    const usersAt = plan.findIndex((s) => s.table === 'users');
    const membershipsAt = plan.findIndex((s) => s.table === 'memberships');
    // Rows whose NOT NULL references pin the purge: deleted outright.
    const invite = plan.find((s) => s.table === 'invite_sms_audit');
    const lock = plan.find((s) => s.table === 'payroll_month_locks');
    const offCycle = plan.find((s) => s.table === 'payroll_off_cycle_lines');
    expect(invite!.where).toBe('membership_user_id = $1');
    expect(lock!.where).toBe('locked_by = $1');
    // Lines OTHERS staged on the person's memberships cascade away with them —
    // the step must take those too, or the backup loses them.
    expect(offCycle!.where).toBe('created_by = $1 or membership_id in (select id from public.memberships where user_id = $1)');
    for (const step of [invite, lock, offCycle]) {
      expect(plan.indexOf(step!)).toBeLessThan(membershipsAt);
      expect(plan.indexOf(step!)).toBeLessThan(usersAt);
    }
    // A report-queue pause is the company's state — the authorship NULLs out
    // (like memberships.invited_by), the pause itself survives the purge.
    const pause = plan.find((s) => s.table === 'report_queue_pauses');
    expect(pause!.updateSet).toBe('paused_by = NULL');
    expect(pause!.where).toBe('paused_by = $1');
    expect(plan.indexOf(pause!)).toBeLessThan(usersAt);
  });

  test('person plan keeps jobs the person authored and decided — except rejected ones the CHECK pins', () => {
    const plan = personPlan('u');
    const jobSteps = plan.filter((s) => s.table === 'jobs');
    expect(jobSteps).toHaveLength(3);
    // created_by NULLs out so the company keeps the job (invited_by precedent).
    expect(jobSteps[0]!.updateSet).toBe('created_by = NULL');
    expect(jobSteps[0]!.where).toBe('created_by = $1');
    // decided_by NULLs out too — but a rejected job PINS decided_by via its
    // status CHECK, so only non-rejected rows can lose the link.
    expect(jobSteps[1]!.updateSet).toBe('decided_by = NULL');
    expect(jobSteps[1]!.where).toBe("decided_by = $1 and status <> 'rejected'");
    // The delete takes their own work plus the rejected jobs they decided.
    expect(jobSteps[2]!.updateSet).toBeUndefined();
    expect(jobSteps[2]!.where).toBe("technician_id = $1 or (status = 'rejected' and decided_by = $1)");
    const usersAt = plan.findIndex((s) => s.table === 'users');
    for (const step of jobSteps) expect(plan.indexOf(step)).toBeLessThan(usersAt);
  });

  test('company plan deletes the tenant payroll/invite rows and twins the cross-tenant pins', () => {
    const plan = companyPlan('t', ['m1', 'm2']);
    const usersAt = plan.findIndex((s) => s.table === 'users');
    for (const table of ['invite_sms_audit', 'payroll_month_locks', 'payroll_off_cycle_lines', 'report_queue_pauses']) {
      const own = plan.find((s) => s.table === table && s.where === 'tenant_id = $1');
      expect(own, `byTenant step for ${table}`).toBeDefined();
      expect(plan.indexOf(own!)).toBeLessThan(usersAt);
    }
    // Cross-tenant pins: NOT NULL references delete, the nullable pause NULLs.
    const inviteCross = plan.find((s) => s.table === 'invite_sms_audit' && s.where.includes('tenant_id <> $2'));
    expect(inviteCross!.where).toBe('(membership_user_id = ANY($1::uuid[])) and tenant_id <> $2');
    const lockCross = plan.find((s) => s.table === 'payroll_month_locks' && s.where.includes('tenant_id <> $2'));
    expect(lockCross!.where).toBe('(locked_by = ANY($1::uuid[])) and tenant_id <> $2');
    const offCross = plan.find((s) => s.table === 'payroll_off_cycle_lines' && s.where.includes('tenant_id <> $2'));
    expect(offCross!.where).toBe('(created_by = ANY($1::uuid[]) or membership_id in (select id from public.memberships where user_id = ANY($1::uuid[]))) and tenant_id <> $2');
    const pauseCross = plan.find((s) => s.table === 'report_queue_pauses' && s.where.includes('tenant_id <> $2'));
    expect(pauseCross!.updateSet).toBe('paused_by = NULL');
    expect(pauseCross!.where).toBe('paused_by = ANY($1::uuid[]) and tenant_id <> $2');
    for (const step of [inviteCross, lockCross, offCross, pauseCross]) {
      expect(plan.indexOf(step!)).toBeLessThan(usersAt);
    }
  });

  test('company plan: cross-tenant job authorship NULLs out, rejected decisions delete, backups cover them', () => {
    const plan = companyPlan('t', ['m1', 'm2']);
    const usersAt = plan.findIndex((s) => s.table === 'users');
    const jobCross = plan.filter((s) => s.table === 'jobs' && s.where.includes('tenant_id <> $2'));
    expect(jobCross).toHaveLength(3);
    expect(jobCross[0]!.updateSet).toBe('created_by = NULL');
    expect(jobCross[1]!.updateSet).toBe('decided_by = NULL');
    expect(jobCross[2]!.where).toBe("(technician_id = ANY($1::uuid[]) or (status = 'rejected' and decided_by = ANY($1::uuid[]))) and tenant_id <> $2");
    for (const step of jobCross) expect(plan.indexOf(step)).toBeLessThan(usersAt);
    // The cross-tenant activity/attachment steps scope to the same job set
    // (their photos and other actors' activity are backed up before the job goes).
    for (const table of ['activity_logs', 'attachment_uploads', 'attachments']) {
      const step = plan.find((s) => s.table === table && s.where.includes('tenant_id <> $2'));
      expect(step!.where).toContain("(status = 'rejected' and decided_by = ANY($1::uuid[]))");
    }
  });
});
