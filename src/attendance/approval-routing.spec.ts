import {
  approverRecipients,
  decisionFor,
  mayDecide,
  resolveApproversWithTree,
  type ApprovalTree,
} from './approval-routing';

const ADMIN = 'admin-1';
const ADMIN_2 = 'admin-2';
const MANAGER = 'mgr-1';
const TOP = 'top-1';
const EMP = 'emp-1';

function member(
  userId: string,
  managerId: string | null,
  overrides: Partial<{
    role: string;
    status: string;
    disabled: boolean;
  }> = {},
) {
  return {
    userId,
    managerId,
    role: overrides.role ?? 'employee',
    status: overrides.status ?? 'active',
    disabled: overrides.disabled ?? false,
  };
}

function tree(...rows: ReturnType<typeof member>[]): ApprovalTree {
  return new Map(rows.map((row) => [row.userId, row]));
}

const admins = [
  member(ADMIN, null, { role: 'company_admin' }),
  member(ADMIN_2, null, { role: 'company_admin' }),
];

describe('resolveApproversWithTree (24-3/CAP-3)', () => {
  it('answers the nearest active manager as the single approver', () => {
    const set = resolveApproversWithTree(
      tree(...admins, member(MANAGER, null), member(EMP, MANAGER)),
      EMP,
      EMP,
    );
    expect(set).toEqual({ kind: 'single', userId: MANAGER });
    expect(approverRecipients(set)).toEqual([MANAGER]);
  });

  it('skips an inactive or disabled candidate and climbs past them', () => {
    const set = resolveApproversWithTree(
      tree(
        ...admins,
        member(MANAGER, null, { status: 'deactivated' }),
        member(TOP, MANAGER),
        member(EMP, TOP),
      ),
      EMP,
      EMP,
    );
    // TOP is eligible and assigned, so TOP decides; getting there required
    // climbing past the parked manager.
    expect(set).toEqual({ kind: 'single', userId: TOP });
  });

  it('answers the fallback set of active admins when the walk steps up from an unassigned member', () => {
    const set = resolveApproversWithTree(
      tree(...admins, member(EMP, null)),
      EMP,
      EMP,
    );
    expect(set).toEqual({ kind: 'fallback', userIds: [ADMIN, ADMIN_2] });
    expect(approverRecipients(set)).toEqual([ADMIN, ADMIN_2]);
  });

  it('keeps an unassigned active member as the single approver when the walk climbs past an inactive one, ahead of the fallback', () => {
    const set = resolveApproversWithTree(
      tree(
        ...admins,
        member(MANAGER, null),
        member(TOP, MANAGER, { status: 'deactivated' }),
        member(EMP, TOP),
      ),
      EMP,
      EMP,
    );
    // Both admins exist, yet the nearest eligible member decides: an
    // unassigned manager is still an approver, not a reason to fall back.
    expect(set).toEqual({ kind: 'single', userId: MANAGER });
  });

  it('steps UP to the fallback from an inactive unassigned member', () => {
    const set = resolveApproversWithTree(
      tree(
        ...admins,
        member(MANAGER, null, { status: 'deactivated' }),
        member(EMP, MANAGER),
      ),
      EMP,
      EMP,
    );
    // The only candidate above EMP is parked: the walk reaches their missing
    // manager and resolves to the admin fallback set.
    expect(set).toEqual({ kind: 'fallback', userIds: [ADMIN, ADMIN_2] });
  });

  it('an admin filing their own leave decides it themself — no recipients', () => {
    const set = resolveApproversWithTree(
      tree(...admins, member(EMP, null)),
      ADMIN,
      ADMIN,
    );
    expect(set).toEqual({ kind: 'self', userId: ADMIN });
    expect(approverRecipients(set)).toEqual([]);
  });

  it('never returns the actor of an on-behalf filing, and excludes them from the fallback', () => {
    const set = resolveApproversWithTree(
      tree(...admins, member(MANAGER, null), member(EMP, MANAGER)),
      EMP,
      MANAGER,
    );
    // The manager filed for their own report: the walk climbs past the actor
    // to the admin above (MANAGER is unassigned, so the up-step is fallback).
    expect(set).toEqual({ kind: 'fallback', userIds: [ADMIN, ADMIN_2] });
    expect(approverRecipients(set)).not.toContain(MANAGER);
  });

  it('answers unresolved(ownerless) when there is no active admin and no manager', () => {
    const set = resolveApproversWithTree(tree(member(EMP, null)), EMP, EMP);
    expect(set).toEqual({ kind: 'unresolved', reason: 'ownerless' });
  });

  it('answers unresolved(corrupt) on a revisit instead of spinning', () => {
    // The actor is skipped, and climbing past them lands back on the
    // requester — a hand-written loop.
    const set = resolveApproversWithTree(
      tree(...admins, member(MANAGER, EMP), member(EMP, MANAGER)),
      EMP,
      MANAGER,
    );
    expect(set).toEqual({ kind: 'unresolved', reason: 'corrupt' });
  });

  it('a missing requester is corrupt, not an empty set', () => {
    const set = resolveApproversWithTree(tree(...admins), 'ghost', 'ghost');
    expect(set).toEqual({ kind: 'unresolved', reason: 'corrupt' });
  });
});

describe('mayDecide (24-3/CAP-3)', () => {
  const single = { kind: 'single', userId: MANAGER } as const;
  const fallback = { kind: 'fallback', userIds: [ADMIN, ADMIN_2] } as const;
  const unresolved = { kind: 'unresolved', reason: 'ownerless' } as const;

  it('lets the single approver and any fallback member decide', () => {
    expect(mayDecide(single, MANAGER, false)).toBe(true);
    expect(mayDecide(single, EMP, false)).toBe(false);
    expect(mayDecide(fallback, ADMIN_2, false)).toBe(true);
    expect(mayDecide(fallback, MANAGER, false)).toBe(false);
  });

  it('keeps the admin override on any request', () => {
    expect(mayDecide(single, ADMIN, true)).toBe(true);
    expect(mayDecide(unresolved, ADMIN, true)).toBe(true);
  });

  it('nobody decides an unresolved request', () => {
    expect(mayDecide(unresolved, ADMIN, false)).toBe(false);
  });
});

describe('decisionFor (24-5/CAP-5)', () => {
  const single = { kind: 'single', userId: MANAGER } as const;
  const fallback = { kind: 'fallback', userIds: [ADMIN, ADMIN_2] } as const;
  const unresolved = { kind: 'unresolved', reason: 'ownerless' } as const;

  it('answers canDecide for the resolved approver and any fallback admin', () => {
    expect(decisionFor(single, MANAGER, false, true)).toEqual({
      canDecide: true,
      reason: null,
    });
    expect(decisionFor(fallback, ADMIN_2, false, true)).toEqual({
      canDecide: true,
      reason: null,
    });
  });

  it('gives the read-only reason a higher manager needs', () => {
    expect(decisionFor(single, TOP, false, true)).toEqual({
      canDecide: false,
      reason: 'higher_manager',
    });
  });

  it('answers not_pending before anything else', () => {
    expect(decisionFor(single, MANAGER, false, false)).toEqual({
      canDecide: false,
      reason: 'not_pending',
    });
  });

  it('names an unresolved tree, while the admin override still decides', () => {
    expect(decisionFor(unresolved, MANAGER, false, true)).toEqual({
      canDecide: false,
      reason: 'unresolved',
    });
    expect(decisionFor(unresolved, ADMIN, true, true)).toEqual({
      canDecide: true,
      reason: null,
    });
  });
});
