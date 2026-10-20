/**
 * Unit-test stub for the company-member reader (src/common/members/
 * company-members.ts). That reader runs
 * `from('memberships').select(...).eq('tenant_id', ..).order(..)` and then
 * optional `.eq` / `.in` / `.neq` filters, awaited. This stub answers that
 * whole chain with fixed rows and records every filter so a test can assert
 * the company filter, role filter and removed-member exclusion were applied.
 */

export interface StubMemberRow {
  user_id: string;
  role: string;
  status: string;
  employee_code: string;
  created_at: string;
  users: {
    name: string | null;
    country_code: string;
    phone_number: string;
    user_skills?: unknown;
  } | null;
}

/** A membership row as the database returns it, with sensible defaults. */
export function memberRow(
  userId: string,
  over: {
    name?: string | null;
    role?: string;
    status?: string;
    employeeCode?: string;
    createdAt?: string;
    countryCode?: string;
    phoneNumber?: string;
    skills?: Array<{ id: string; name: string }>;
  } = {},
): StubMemberRow {
  return {
    user_id: userId,
    role: over.role ?? 'employee',
    status: over.status ?? 'active',
    employee_code: over.employeeCode ?? 'EMP-0001',
    created_at: over.createdAt ?? '2026-06-20T00:00:00Z',
    users: {
      name: over.name === undefined ? `Name ${userId}` : over.name,
      country_code: over.countryCode ?? '+91',
      phone_number: over.phoneNumber ?? '9000000000',
      ...(over.skills
        ? { user_skills: over.skills.map((skills) => ({ skills })) }
        : {}),
    },
  };
}

export type FilterCall = [method: string, ...args: unknown[]];

/** The memberships table: `select` starts the chain, `filters` records the rest. */
export function membersTable(
  result: { data: StubMemberRow[] | null; error: unknown } | StubMemberRow[],
) {
  const resolved = Array.isArray(result)
    ? { data: result, error: null }
    : result;
  const filters: FilterCall[] = [];
  const select = jest.fn();
  const node: Record<string, unknown> = {};
  for (const method of ['eq', 'in', 'neq', 'order']) {
    node[method] = jest.fn((...args: unknown[]) => {
      filters.push([method, ...args]);
      return node;
    });
  }
  node['then'] = (
    ok: (v: unknown) => unknown,
    fail: (e: unknown) => unknown,
  ) => Promise.resolve(resolved).then(ok, fail);
  select.mockReturnValue(node);
  return { select, filters };
}
