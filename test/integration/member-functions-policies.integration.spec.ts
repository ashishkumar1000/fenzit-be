/**
 * Row-level security added in migration 20261020000005 — real DEV database
 * suite, authenticated clients like rls-membership-policies:
 *   - activity_logs is append-only (employee and admin may add, nobody edits
 *     or deletes);
 *   - user_skills: a person edits their OWN skills (any role), a company admin
 *     edits anyone's in the company, an employee cannot edit a colleague's.
 *
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import {
  IS_REAL_DB,
  POINTS_AT_LIVE,
} from '../helpers/member-functions-fixture';
import {
  Company,
  makeCompany,
  teardownSuite,
} from '../helpers/member-functions-company';
import { JobFixture, seedJob } from '../helpers/member-functions-job';
import { apiClient, mintJwt, serviceRoleClient } from '../helpers/rls-seed';

describe('activity_logs and user_skills policies (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);
  let c: Company;
  let outsider: Company;
  let job: JobFixture;

  const as = (name: string) => apiClient(mintJwt(c.id[name]));
  const code = (e: unknown) => (e as { code?: string } | null)?.code;
  const skillRows = async (user: string) => {
    const { data } = await service
      .from('user_skills')
      .select('skill_id')
      .eq('user_id', user);
    return (data as { skill_id: string }[]).map((r) => r.skill_id).sort();
  };
  const logCount = async () => {
    const { count } = await service
      .from('activity_logs')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', job.jobId);
    return count;
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    expect(POINTS_AT_LIVE).toBe(false);
    await teardownSuite(service);
    c = await makeCompany(service, 'policies', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
      emp2: { role: 'employee' },
      viewer: { role: 'viewer' },
      gone: { role: 'employee', status: 'removed' },
    });
    outsider = await makeCompany(service, 'policies other', {
      admin: { role: 'company_admin' },
    });
    job = await seedJob(service, c.tenantId, c.id.emp, c.id.admin);
  }, 120000);
  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service);
  }, 120000);

  const entry = (actor: string, type: string) => ({
    job_id: job.jobId,
    tenant_id: c.tenantId,
    event_type: type,
    actor_id: actor,
  });

  maybeIt(
    'activity_logs: employee and admin can INSERT, a viewer cannot',
    async () => {
      const before = (await logCount()) ?? 0;
      for (const who of ['emp', 'admin']) {
        const { error } = await as(who)
          .from('activity_logs')
          .insert(entry(c.id[who], `note_${who}`));
        expect({ who, error }).toEqual({ who, error: null });
      }
      const { error } = await as('viewer')
        .from('activity_logs')
        .insert(entry(c.id.viewer, 'note_viewer'));
      expect(code(error)).toBe('42501');
      expect(await logCount()).toBe(before + 2);
    },
  );

  maybeIt(
    'activity_logs: nobody (employee, admin) can UPDATE or DELETE an entry; the history is unchanged',
    async () => {
      const { data: rows } = await service
        .from('activity_logs')
        .select('id, event_type')
        .eq('job_id', job.jobId);
      const snapshot = JSON.stringify(rows);
      const count = await logCount();
      for (const who of ['emp', 'admin']) {
        const client = as(who);
        const upd = await client
          .from('activity_logs')
          .update({ event_type: 'forged' })
          .eq('job_id', job.jobId)
          .select();
        expect({ who, rows: upd.data ?? [] }).toEqual({ who, rows: [] });
        const del = await client
          .from('activity_logs')
          .delete()
          .eq('job_id', job.jobId)
          .select();
        expect({ who, rows: del.data ?? [] }).toEqual({ who, rows: [] });
      }
      expect(await logCount()).toBe(count);
      const { data: after } = await service
        .from('activity_logs')
        .select('id, event_type')
        .eq('job_id', job.jobId);
      expect(JSON.stringify(after)).toBe(snapshot);
    },
  );

  maybeIt(
    "user_skills: an employee cannot add, change or delete a COLLEAGUE's skills",
    async () => {
      const [s1, s2] = job.skillIds;
      await service
        .from('user_skills')
        .insert({ user_id: c.id.emp2, skill_id: s1 });
      const emp = as('emp');
      const ins = await emp
        .from('user_skills')
        .insert({ user_id: c.id.emp2, skill_id: s2 });
      expect(code(ins.error)).toBe('42501');
      const upd = await emp
        .from('user_skills')
        .update({ skill_id: s2 })
        .eq('user_id', c.id.emp2)
        .select();
      expect(upd.data ?? []).toEqual([]);
      const del = await emp
        .from('user_skills')
        .delete()
        .eq('user_id', c.id.emp2)
        .select();
      expect(del.data ?? []).toEqual([]);
      expect(await skillRows(c.id.emp2)).toEqual([s1]);
    },
  );

  maybeIt(
    'user_skills: an employee and a viewer can edit their OWN skills',
    async () => {
      const [s1] = job.skillIds;
      for (const who of ['emp', 'viewer']) {
        const client = as(who);
        await service.from('user_skills').delete().eq('user_id', c.id[who]);
        const ins = await client
          .from('user_skills')
          .insert({ user_id: c.id[who], skill_id: s1 });
        expect({ who, error: ins.error }).toEqual({ who, error: null });
        expect(await skillRows(c.id[who])).toEqual([s1]);
        const del = await client
          .from('user_skills')
          .delete()
          .eq('user_id', c.id[who])
          .select();
        expect({ who, n: (del.data ?? []).length }).toEqual({ who, n: 1 });
        expect(await skillRows(c.id[who])).toEqual([]);
      }
    },
  );

  maybeIt(
    'user_skills: a company admin can edit anyone in the company, but not a removed member or another company',
    async () => {
      const [s1] = job.skillIds;
      const admin = as('admin');
      const ins = await admin
        .from('user_skills')
        .insert({ user_id: c.id.emp, skill_id: s1 });
      expect(ins.error).toBeNull();
      const del = await admin
        .from('user_skills')
        .delete()
        .eq('user_id', c.id.emp)
        .select();
      expect((del.data ?? []).length).toBe(1);
      const viewerIns = await admin
        .from('user_skills')
        .insert({ user_id: c.id.viewer, skill_id: s1 });
      expect(viewerIns.error).toBeNull();
      for (const target of [c.id.gone, outsider.id.admin]) {
        const r = await admin
          .from('user_skills')
          .insert({ user_id: target, skill_id: s1 });
        expect({ target, code: code(r.error) }).toEqual({
          target,
          code: '42501',
        });
        expect(await skillRows(target)).toEqual([]);
      }
      // The other company's admin cannot touch this company's people either.
      const foreign = apiClient(mintJwt(outsider.id.admin));
      const f = await foreign
        .from('user_skills')
        .insert({ user_id: c.id.emp, skill_id: s1 });
      expect(code(f.error)).toBe('42501');
    },
  );

  it('(always) suite is wired', () => {
    expect(true).toBe(true);
  });
});
