import {
  MAX_HIERARCHY_DEPTH,
  emptyHierarchy,
  probeManagerAssignment,
  readMemberHierarchy,
} from './hierarchy';

/**
 * The read issues two walks: the upward chain (one row per ancestor of a
 * requested member) and the downward subtree (one row per descendant, tagged
 * with the root it hangs from).
 */
function txReturning(upRows: unknown[], downRows: unknown[] = []) {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: upRows, rowCount: upRows.length })
    .mockResolvedValueOnce({ rows: downRows, rowCount: downRows.length });
  return { query };
}

const up = (
  node_id: string,
  ancestor_id: string,
  depth: number,
  name: string,
) => ({ node_id, ancestor_id, depth, name });
const down = (
  root_id: string,
  node_id: string,
  depth: number,
  disabled = false,
) => ({ root_id, node_id, depth, disabled });

describe('readMemberHierarchy', () => {
  it('answers the empty hierarchy for everyone when nobody reports to anybody', async () => {
    const tx = txReturning([]);
    const map = await readMemberHierarchy(tx, 'tenant-A', ['a', 'b']);
    expect(map.get('a')).toEqual(emptyHierarchy());
    expect(map.get('b')).toEqual(emptyHierarchy());
  });

  it('walks the chain nearest-first and counts the subtree and the direct reports', async () => {
    const tx = txReturning(
      [
        up('a', 'b', 1, 'Bina'),
        up('a', 'o', 2, 'Owner'),
        up('b', 'o', 1, 'Owner'),
      ],
      [down('b', 'a', 1), down('o', 'a', 2), down('o', 'b', 1)],
    );

    const map = await readMemberHierarchy(tx, 'tenant-A', ['a', 'b', 'o']);

    expect(map.get('a')).toMatchObject({
      managerId: 'b',
      managerName: 'Bina',
      chain: [
        { userId: 'b', name: 'Bina' },
        { userId: 'o', name: 'Owner' },
      ],
      headcount: 0,
      directReports: 0,
    });
    // b has one direct report (a) and one person below in the subtree.
    expect(map.get('b')).toMatchObject({
      managerId: 'o',
      headcount: 1,
      directReports: 1,
    });
    // The owner has two people below: one direct (b) and one indirect (a).
    expect(map.get('o')).toMatchObject({
      managerId: null,
      headcount: 2,
      directReports: 1,
    });
  });

  it('does not count a disabled account as part of the headcount', async () => {
    const tx = txReturning(
      [],
      [down('m', 'gone', 1, true), down('m', 'here', 1)],
    );

    const map = await readMemberHierarchy(tx, 'tenant-A', ['m']);

    expect(map.get('m')).toMatchObject({ headcount: 1, directReports: 1 });
  });

  it('skips the self-ancestor of a corrupt loop instead of showing the member reporting to themselves', async () => {
    const tx = txReturning([
      up('a', 'b', 1, 'B'),
      up('a', 'a', 2, 'A'),
      up('a', 'b', 3, 'B'),
    ]);

    const map = await readMemberHierarchy(tx, 'tenant-A', ['a']);

    expect(map.get('a')?.chain.map((link) => link.userId)).toEqual(['b']);
    expect(map.get('a')?.managerId).toBe('b');
  });

  it('runs no query when there is nobody to read', async () => {
    const tx = txReturning([]);
    await readMemberHierarchy(tx, 'tenant-A', []);
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('scopes both walks to the requested ids and the company, not the whole roster', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [] });
      }),
    };
    await readMemberHierarchy(tx, 'tenant-A', ['a']);

    expect(calls).toHaveLength(2);
    // Both walks read the same live roster, filtered by tenant.
    for (const call of calls) {
      expect(call.params).toEqual(['tenant-A', ['a']]);
      expect(call.sql).toContain('m.tenant_id = $1');
    }
    // The upward walk is seeded at the requested id, never at every member.
    expect(calls[0].sql).toContain(
      'where m.user_id = any($2::uuid[]) and m.manager_id is not null',
    );
    expect(calls[0].sql).not.toContain(
      'from live m\n        where m.manager_id is not null',
    );
    // The downward walk is seeded at the requested id too and carries the root.
    expect(calls[1].sql).toContain('select c.user_id, d.root_id, d.depth + 1');
    expect(calls[1].sql).toContain('d.root_id');
  });

  it('caps both walks at the shared depth limit', async () => {
    expect(MAX_HIERARCHY_DEPTH).toBe(20);
    const calls: string[] = [];
    const tx = {
      query: jest.fn((sql: string) => {
        calls.push(sql);
        return Promise.resolve({ rows: [] });
      }),
    };
    await readMemberHierarchy(tx, 'tenant-A', ['a']);
    expect(calls[0]).toContain(`u.depth < ${MAX_HIERARCHY_DEPTH}`);
    expect(calls[1]).toContain(`d.depth < ${MAX_HIERARCHY_DEPTH + 1}`);
  });
});

describe('probeManagerAssignment', () => {
  it('reports the loop and the depth facts in one query', async () => {
    const tx = txReturning([
      { cycle: true, manager_ancestors: 3, subtree_depth: 4 },
    ]);

    await expect(
      probeManagerAssignment(tx, 'tenant-A', 'member-1', 'mgr-1'),
    ).resolves.toEqual({
      cycle: true,
      managerAncestors: 3,
      subtreeDepth: 4,
    });
  });

  it('defaults to "no loop, shallow branch" when the walk returns nothing', async () => {
    const tx = txReturning([]);

    await expect(
      probeManagerAssignment(tx, 'tenant-A', 'member-1', 'mgr-1'),
    ).resolves.toEqual({
      cycle: false,
      managerAncestors: 0,
      subtreeDepth: 0,
    });
  });
});
