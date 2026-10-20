import { SupabaseClient } from '@supabase/supabase-js';
import { listCompanyMembers } from './company-members';

/**
 * A chainable stand-in for the Supabase query builder. Every filter is
 * recorded so a test can prove the company scope and the removed-member rule
 * are applied, and the awaited result is whatever the test hands in.
 */
function stub(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'neq', 'in', 'order']) {
    builder[name] = jest.fn((...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    });
  }
  builder['then'] = (resolve: (v: unknown) => void) => resolve(result);
  const from = jest.fn(() => builder);
  const admin = { from } as unknown as SupabaseClient;
  return { admin, calls, from };
}

const identity = (over: Record<string, unknown> = {}) => ({
  name: 'Asha',
  country_code: '+91',
  phone_number: '9000000001',
  disabled: false,
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  user_id: 'u-1',
  role: 'employee',
  status: 'active',
  employee_code: 'EMP-001',
  created_at: '2026-10-01T00:00:00Z',
  users: identity(),
  ...over,
});

describe('listCompanyMembers', () => {
  it('reads only the named company', async () => {
    const { admin, calls } = stub({ data: [], error: null });
    await listCompanyMembers(admin, 'tenant-A');
    expect(calls).toContainEqual(['eq', ['tenant_id', 'tenant-A']]);
  });

  it('leaves removed members out by default', async () => {
    const { admin, calls } = stub({ data: [], error: null });
    await listCompanyMembers(admin, 'tenant-A');
    expect(calls).toContainEqual(['neq', ['status', 'removed']]);
  });

  it('keeps removed members only when history is asked for', async () => {
    const { admin, calls } = stub({ data: [], error: null });
    await listCompanyMembers(admin, 'tenant-A', { includeRemoved: true });
    expect(calls.map(([name]) => name)).not.toContain('neq');
  });

  it('never returns a disabled person, so they are not shown as team', async () => {
    const { admin } = stub({
      data: [
        row({ user_id: 'u-live' }),
        row({ user_id: 'u-off', users: identity({ disabled: true }) }),
      ],
      error: null,
    });
    const members = await listCompanyMembers(admin, 'tenant-A');
    expect(members.map((m) => m.userId)).toEqual(['u-live']);
  });

  it('skips a membership whose identity row is missing rather than inventing one', async () => {
    const { admin } = stub({
      data: [row({ user_id: 'u-orphan', users: null }), row()],
      error: null,
    });
    const members = await listCompanyMembers(admin, 'tenant-A');
    expect(members.map((m) => m.userId)).toEqual(['u-1']);
  });

  it('returns no rows and does not query when asked for an empty list of people', async () => {
    const { admin, from } = stub({ data: [row()], error: null });
    await expect(
      listCompanyMembers(admin, 'tenant-A', { userIds: [] }),
    ).resolves.toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it('filters to the given people when userIds is set', async () => {
    const { admin, calls } = stub({ data: [], error: null });
    await listCompanyMembers(admin, 'tenant-A', { userIds: ['u-1', 'u-2'] });
    expect(calls).toContainEqual(['in', ['user_id', ['u-1', 'u-2']]]);
  });

  it('filters by role when a role is asked for', async () => {
    const { admin, calls } = stub({ data: [], error: null });
    await listCompanyMembers(admin, 'tenant-A', { role: 'company_admin' });
    expect(calls).toContainEqual(['eq', ['role', 'company_admin']]);
  });

  it('maps a row to the member shape, including the company role and status', async () => {
    const { admin } = stub({
      data: [row({ role: 'viewer', status: 'invited' })],
      error: null,
    });
    const [member] = await listCompanyMembers(admin, 'tenant-A');
    expect(member).toEqual({
      userId: 'u-1',
      name: 'Asha',
      countryCode: '+91',
      phoneNumber: '9000000001',
      employeeCode: 'EMP-001',
      role: 'viewer',
      status: 'invited',
      createdAt: '2026-10-01T00:00:00Z',
    });
    expect(member).not.toHaveProperty('skills');
  });

  it('flattens skills whether the embed comes back as an object, an array or null', async () => {
    const { admin } = stub({
      data: [
        row({
          users: identity({
            user_skills: [
              { skills: { id: 's-1', name: 'AC' } },
              { skills: [{ id: 's-2', name: 'Plumbing' }] },
              { skills: null },
            ],
          }),
        }),
      ],
      error: null,
    });
    const [member] = await listCompanyMembers(admin, 'tenant-A', {
      withSkills: true,
    });
    expect(member?.skills).toEqual([
      { id: 's-1', name: 'AC' },
      { id: 's-2', name: 'Plumbing' },
    ]);
  });

  it('gives an empty skills list when the person has none', async () => {
    const { admin } = stub({
      data: [row({ users: identity({ user_skills: null }) })],
      error: null,
    });
    const [member] = await listCompanyMembers(admin, 'tenant-A', {
      withSkills: true,
    });
    expect(member?.skills).toEqual([]);
  });

  it('throws when the database read fails, so a caller never sees a false empty team', async () => {
    const dbError = { code: '57P01', message: 'connection lost' };
    const { admin } = stub({ data: null, error: dbError });
    await expect(listCompanyMembers(admin, 'tenant-A')).rejects.toBe(dbError);
  });
});
