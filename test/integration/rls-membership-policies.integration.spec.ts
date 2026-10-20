/**
 * RLS role and membership policies (roles work, migrations 20261020000001-4)
 *
 * Companion to rls-isolation.integration.spec.ts. That suite proves company A
 * cannot read company B. This one proves what the NEW policies add:
 *   - a viewer reads company rows but writes nothing (except a report request);
 *   - an employee cannot write customers; a company admin can;
 *   - a removed, invited or disabled person loses (or never gets) access with
 *     the SAME token — the role is read from the database on every query;
 *   - a forged `tenantId` claim grants nothing;
 *   - `memberships` is not reachable through the API at all, and `audit_log`
 *     is readable only by the company admin of the same company and is
 *     append-only.
 *
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 * DATABASE_URL is used to prove the audit_log trigger and to clean audit rows.
 */
import { Client } from 'pg';
import {
  apiClient,
  mintJwt,
  purgeCompany,
  seedCompany,
  serviceRoleClient,
} from '../helpers/rls-seed';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const IS_REAL_DB =
  SUPABASE_URL !== '' && !SUPABASE_URL.includes('test.supabase.co');

// 00000000-…-c* block (the main suite uses a*, b*, 8*, 9*, f*).
const id = (suffix: string) => `00000000-0000-0000-0000-0000000000${suffix}`;
const P = {
  tenantC: id('c1'),
  adminC: id('c2'),
  employeeC: id('c3'),
  viewerC: id('c4'),
  employeeGone: id('c5'), // removed during the removal test
  adminSwitch: id('c6'), // second admin, disabled during the disabled test
  invitedC: id('c7'),
  removedC: id('c8'), // removed before the suite starts
  tenantD: id('c9'),
  adminD: id('ca'),
  stranger: id('cb'),
};
const PEOPLE_C = [
  P.adminC,
  P.employeeC,
  P.viewerC,
  P.employeeGone,
  P.adminSwitch,
  P.invitedC,
  P.removedC,
];
const PEOPLE_D = [P.adminD, P.stranger];

describe('RLS role and membership policies', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);
  let customerId = '';
  let jobId = '';
  let skillId = '';
  let templateId = '';

  const countRows = async (table: string, column: string, value: string) => {
    const { count, error } = await service
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(column, value);
    expect(error).toBeNull();
    return count;
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    await seedCompany(service, {
      tenantId: P.tenantC,
      companyName: 'RLS Policy Co C',
      createdBy: P.adminC,
      people: [
        { id: P.adminC, phone: '9999000221', role: 'company_admin' },
        { id: P.employeeC, phone: '9999000222', role: 'employee' },
        { id: P.viewerC, phone: '9999000223', role: 'viewer' },
        { id: P.employeeGone, phone: '9999000224', role: 'employee' },
        { id: P.adminSwitch, phone: '9999000225', role: 'company_admin' },
        {
          id: P.invitedC,
          phone: '9999000226',
          role: 'employee',
          status: 'invited',
        },
        {
          id: P.removedC,
          phone: '9999000227',
          role: 'employee',
          status: 'removed',
        },
      ],
    });
    await seedCompany(service, {
      tenantId: P.tenantD,
      companyName: 'RLS Policy Co D',
      createdBy: P.adminD,
      people: [
        { id: P.adminD, phone: '9999000228', role: 'company_admin' },
        { id: P.stranger, phone: '9999000229', role: null },
      ],
    });
    const { data: skill } = await service
      .from('skills')
      .select('id')
      .eq('is_active', true)
      .limit(1)
      .single();
    skillId = (skill as { id: string }).id;
    const { data: customer, error: customerError } = await service
      .from('customers')
      .insert({
        tenant_id: P.tenantC,
        name: 'RLS policy customer',
        country_code: '+91',
        phone_number: '9999000230',
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();
    customerId = (customer as { id: string }).id;
    const { data: jobs, error: jobError } = await service.rpc(
      'create_job_with_log',
      {
        p_tenant_id: P.tenantC,
        p_customer_id: customerId,
        p_technician_id: P.employeeC,
        p_service_location: 'RLS policy location',
        p_skill_id: skillId,
        p_scheduled_start: new Date().toISOString(),
        p_scheduled_end: null,
        p_description: 'RLS policy job',
        p_priority: 'normal',
        p_notes_for_technician: null,
        p_actor_id: P.adminC,
        p_year: new Date().getUTCFullYear(),
      },
    );
    expect(jobError).toBeNull();
    const job = (jobs as { id: string; workflow_template_id: string }[])[0];
    jobId = job.id;
    templateId = job.workflow_template_id;
    const { error: skillError } = await service
      .from('user_skills')
      .insert({ user_id: P.employeeC, skill_id: skillId });
    expect(skillError).toBeNull();
    // One audit row per company (service role is the only writer).
    for (const [tenant, actor, tag] of [
      [P.tenantC, P.adminC, 'rls.probe.c'],
      [P.tenantD, P.adminD, 'rls.probe.d'],
    ]) {
      const { error } = await service.from('audit_log').insert({
        actor_user_id: actor,
        actor_is_platform_admin: false,
        tenant_id: tenant,
        action: tag,
      });
      expect(error).toBeNull();
    }
  }, 120000);

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await purgeCompany(service, P.tenantC, PEOPLE_C);
    await purgeCompany(service, P.tenantD, PEOPLE_D);
  }, 120000);

  /** A valid insert row for each company table, as the given person. */
  const insertRows = (
    userId: string,
  ): Record<string, Record<string, unknown>> => ({
    jobs: {
      tenant_id: P.tenantC,
      job_number: `RLS-${userId.slice(-2)}`,
      customer_id: customerId,
      technician_id: P.employeeC,
      service_location: 'x',
      scheduled_start: new Date().toISOString(),
      skill_id: skillId,
      workflow_template_id: templateId,
      workflow_template_version: 1,
    },
    customers: {
      tenant_id: P.tenantC,
      name: 'RLS written customer',
      country_code: '+91',
      phone_number: '9999000231',
    },
    activity_logs: {
      job_id: jobId,
      tenant_id: P.tenantC,
      event_type: 'rls_probe',
    },
    attachments: {
      job_id: jobId,
      tenant_id: P.tenantC,
      r2_key: `rls-policy/${userId}/a`,
      attachment_type: 'photo',
      size_bytes: 1,
    },
    attachment_uploads: {
      job_id: jobId,
      tenant_id: P.tenantC,
      r2_key: `rls-policy/${userId}/u`,
      attachment_type: 'photo',
      mime_type: 'image/jpeg',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
    idempotency_log: {
      key: `rls-policy-${userId}`,
      tenant_id: P.tenantC,
      scope: 'rls',
      response_body: {},
    },
    user_skills: { user_id: P.employeeC, skill_id: skillId },
  });
  const WRITE_TABLES = Object.keys(insertRows(P.viewerC));
  const CHANGES: Record<string, Record<string, unknown>> = {
    jobs: { description: 'edited' },
    customers: { name: 'edited' },
    activity_logs: { event_type: 'edited' },
    attachments: { size_bytes: 2 },
    attachment_uploads: { mime_type: 'image/png' },
    idempotency_log: { response_body: { edited: true } },
  };

  maybeIt(
    'viewer: reads company rows, every insert/update/delete is refused, a report request is allowed',
    async () => {
      const viewer = apiClient(mintJwt(P.viewerC));
      const before: Record<string, number | null> = {};
      for (const t of ['customers', 'jobs', 'activity_logs', 'user_skills']) {
        const { data, error } = await viewer.from(t).select('*');
        expect(error).toBeNull();
        expect({ t, any: (data as unknown[]).length > 0 }).toEqual({
          t,
          any: true,
        });
      }
      const { data: tenant } = await viewer.from('tenants').select('id');
      expect(tenant).toEqual([{ id: P.tenantC }]);
      for (const t of WRITE_TABLES) {
        before[t] = await countRows(
          t,
          t === 'user_skills' ? 'user_id' : 'tenant_id',
          t === 'user_skills' ? P.employeeC : P.tenantC,
        );
      }

      for (const [table, row] of Object.entries(insertRows(P.viewerC))) {
        const { error } = await viewer.from(table).insert(row);
        expect({
          table,
          code: (error as { code?: string } | null)?.code,
        }).toEqual({
          table,
          code: '42501',
        });
      }
      for (const [table, change] of Object.entries(CHANGES)) {
        const { data, error } = await viewer
          .from(table)
          .update(change)
          .eq('tenant_id', P.tenantC)
          .select();
        expect({ table, error, rows: data }).toEqual({
          table,
          error: null,
          rows: [],
        });
      }
      for (const table of WRITE_TABLES) {
        const column = table === 'user_skills' ? 'user_id' : 'tenant_id';
        const value = table === 'user_skills' ? P.employeeC : P.tenantC;
        const { data, error } = await viewer
          .from(table)
          .delete()
          .eq(column, value)
          .select();
        expect({ table, error, rows: data }).toEqual({
          table,
          error: null,
          rows: [],
        });
        expect(await countRows(table, column, value)).toBe(before[table]);
      }
      // Nothing changed in the rows themselves.
      const { data: job } = await service
        .from('jobs')
        .select('description')
        .eq('id', jobId)
        .single();
      expect((job as { description: string }).description).toBe(
        'RLS policy job',
      );

      // Exception: a viewer may ask for a report (decision 39), but only as
      // themselves and only for their own company, and may not edit it later.
      const report = {
        tenant_id: P.tenantC,
        requested_by: P.viewerC,
        report_type: 'rls_probe',
      };
      const { error: reportError } = await viewer
        .from('report_requests')
        .insert(report);
      expect(reportError).toBeNull();
      const { error: otherCompany } = await viewer
        .from('report_requests')
        .insert({ ...report, tenant_id: P.tenantD });
      expect((otherCompany as { code: string }).code).toBe('42501');
      const { data: edited } = await viewer
        .from('report_requests')
        .update({ report_type: 'edited' })
        .eq('tenant_id', P.tenantC)
        .select();
      expect(edited).toEqual([]);
      const { data: removed } = await viewer
        .from('report_requests')
        .delete()
        .eq('tenant_id', P.tenantC)
        .select();
      expect(removed).toEqual([]);
      expect(await countRows('report_requests', 'tenant_id', P.tenantC)).toBe(
        1,
      );
    },
    60000,
  );

  maybeIt(
    'employee cannot write customers (nothing changes); company admin can; employee can write jobs',
    async () => {
      const employee = apiClient(mintJwt(P.employeeC));
      const row = insertRows(P.employeeC)['customers'];
      const { error: insertError } = await employee
        .from('customers')
        .insert(row);
      expect((insertError as { code: string }).code).toBe('42501');
      const { data: changed } = await employee
        .from('customers')
        .update({ name: 'employee edit' })
        .eq('id', customerId)
        .select();
      expect(changed).toEqual([]);
      const { data: deleted } = await employee
        .from('customers')
        .delete()
        .eq('id', customerId)
        .select();
      expect(deleted).toEqual([]);
      const { data: still } = await service
        .from('customers')
        .select('name')
        .eq('id', customerId)
        .single();
      expect((still as { name: string }).name).toBe('RLS policy customer');
      // Reading is still allowed.
      const { data: read } = await employee.from('customers').select('id');
      expect(read).toEqual([{ id: customerId }]);

      // Jobs: the spec says only a company admin creates and changes a job
      // (roles-and-access-spec permission table). An employee's update is
      // filtered by the policy: no error, no rows, nothing changes.
      const { data: jobEdit, error: jobEditError } = await employee
        .from('jobs')
        .update({ description: 'employee edit' })
        .eq('id', jobId)
        .select('id');
      expect(jobEditError).toBeNull();
      expect(jobEdit).toEqual([]);
      // The employee can see the job, so the empty result above is the write
      // policy refusing, not a job the employee cannot reach.
      const { data: jobSeen } = await employee
        .from('jobs')
        .select('id')
        .eq('id', jobId);
      expect(jobSeen).toEqual([{ id: jobId }]);
      const { data: jobStill } = await service
        .from('jobs')
        .select('description')
        .eq('id', jobId)
        .single();
      expect((jobStill as { description: string }).description).toBe(
        'RLS policy job',
      );

      // Company admin: inserts, edits and deletes a customer in their company,
      // but not in another company.
      const admin = apiClient(mintJwt(P.adminC));
      const { data: created, error: createError } = await admin
        .from('customers')
        .insert(row)
        .select('id')
        .single();
      expect(createError).toBeNull();
      const newId = (created as { id: string }).id;
      const { data: renamed } = await admin
        .from('customers')
        .update({ name: 'admin edit' })
        .eq('id', newId)
        .select('name');
      expect(renamed).toEqual([{ name: 'admin edit' }]);
      const { error: foreignInsert } = await admin
        .from('customers')
        .insert({ ...row, tenant_id: P.tenantD });
      expect((foreignInsert as { code: string }).code).toBe('42501');
      const { data: gone } = await admin
        .from('customers')
        .delete()
        .eq('id', newId)
        .select('id');
      expect(gone).toEqual([{ id: newId }]);
      // Jobs: the company admin can change a job in their own company.
      // (A column the other tests do not assert on.)
      const { data: jobNote } = await admin
        .from('jobs')
        .update({ notes_for_technician: 'admin note' })
        .eq('id', jobId)
        .select('id');
      expect(jobNote).toEqual([{ id: jobId }]);
      const { data: jobNoted } = await service
        .from('jobs')
        .select('notes_for_technician')
        .eq('id', jobId)
        .single();
      expect(jobNoted).toEqual({ notes_for_technician: 'admin note' });
      // Another company's admin cannot change this company's job.
      const otherAdmin = apiClient(mintJwt(P.adminD));
      const { data: foreignJob } = await otherAdmin
        .from('jobs')
        .update({ notes_for_technician: 'foreign note' })
        .eq('id', jobId)
        .select('id');
      expect(foreignJob).toEqual([]);
      const { data: jobAfterForeign } = await service
        .from('jobs')
        .select('notes_for_technician')
        .eq('id', jobId)
        .single();
      expect(jobAfterForeign).toEqual({ notes_for_technician: 'admin note' });
    },
  );

  maybeIt(
    'invited and already-removed people see nothing company-scoped',
    async () => {
      for (const person of [P.invitedC, P.removedC]) {
        const client = apiClient(mintJwt(person));
        for (const t of [
          'customers',
          'jobs',
          'activity_logs',
          'tenants',
          'user_skills',
        ]) {
          const { data, error } = await client.from(t).select('*');
          expect(error).toBeNull();
          expect({ person, t, rows: data }).toEqual({ person, t, rows: [] });
        }
        const { data: users } = await client.from('users').select('id');
        expect(users).toEqual([{ id: person }]); // only their own row
        const { error } = await client
          .from('customers')
          .insert(insertRows(person)['customers']);
        expect((error as { code: string }).code).toBe('42501');
      }
    },
  );

  maybeIt(
    'removed member loses all access immediately with the SAME token',
    async () => {
      const client = apiClient(mintJwt(P.employeeGone)); // one token for the whole test
      const { data: before } = await client.from('jobs').select('id');
      expect(before).toEqual([{ id: jobId }]);
      const { data: tenantBefore } = await client.from('tenants').select('id');
      expect(tenantBefore).toEqual([{ id: P.tenantC }]);

      const { error } = await service
        .from('memberships')
        .update({ status: 'removed' })
        .eq('user_id', P.employeeGone)
        .eq('tenant_id', P.tenantC);
      expect(error).toBeNull();

      for (const t of [
        'jobs',
        'customers',
        'activity_logs',
        'tenants',
        'user_skills',
      ]) {
        const { data, error: readError } = await client.from(t).select('*');
        expect(readError).toBeNull();
        expect({ t, rows: data }).toEqual({ t, rows: [] });
      }
      const { data: people } = await client.from('users').select('id');
      expect(people).toEqual([{ id: P.employeeGone }]);
      const { error: writeError } = await client
        .from('jobs')
        .update({ description: 'after removal' })
        .eq('id', jobId);
      expect(writeError).toBeNull(); // filtered, not an error
      const { data: job } = await service
        .from('jobs')
        .select('description')
        .eq('id', jobId)
        .single();
      expect((job as { description: string }).description).not.toBe(
        'after removal',
      );
      const { error: insertError } = await client
        .from('activity_logs')
        .insert(insertRows(P.employeeGone)['activity_logs']);
      expect((insertError as { code: string }).code).toBe('42501');
    },
  );

  maybeIt(
    'disabled user loses access with the SAME token, and gets it back when re-enabled',
    async () => {
      const client = apiClient(mintJwt(P.adminSwitch));
      const read = async () =>
        (await client.from('customers').select('id')).data;
      expect(await read()).toEqual([{ id: customerId }]);

      let { error } = await service
        .from('users')
        .update({ disabled: true })
        .eq('id', P.adminSwitch);
      expect(error).toBeNull();
      expect(await read()).toEqual([]);
      const { data: tenants } = await client.from('tenants').select('id');
      expect(tenants).toEqual([]);
      const { error: writeError } = await client
        .from('customers')
        .insert(insertRows(P.adminSwitch)['customers']);
      expect((writeError as { code: string }).code).toBe('42501');
      const { data: audit } = await client.from('audit_log').select('id');
      expect(audit).toEqual([]);

      ({ error } = await service
        .from('users')
        .update({ disabled: false })
        .eq('id', P.adminSwitch));
      expect(error).toBeNull();
      expect(await read()).toEqual([{ id: customerId }]);
    },
  );

  maybeIt('a forged tenantId claim grants nothing', async () => {
    // Company D's admin and a person with no membership both claim to be in
    // company C. The policies ignore the claim and read memberships.
    const forgers = [
      { who: 'admin of D', userId: P.adminD, own: P.tenantD },
      { who: 'stranger', userId: P.stranger, own: null },
    ];
    for (const f of forgers) {
      const client = apiClient(
        mintJwt(f.userId, {
          tenantId: P.tenantC,
          tenant_id: P.tenantC,
          app_role: 'company_admin',
        }),
      );
      for (const t of ['customers', 'jobs', 'activity_logs', 'user_skills']) {
        const { data, error } = await client.from(t).select('*');
        expect(error).toBeNull();
        expect({ who: f.who, t, rows: data }).toEqual({
          who: f.who,
          t,
          rows: [],
        });
      }
      const { data: tenants } = await client.from('tenants').select('id');
      expect(tenants).toEqual(f.own ? [{ id: f.own }] : []);
      const { error } = await client
        .from('customers')
        .insert(insertRows(f.userId)['customers']);
      expect({ who: f.who, code: (error as { code: string }).code }).toEqual({
        who: f.who,
        code: '42501',
      });
      const { data: audit } = await client.from('audit_log').select('action');
      expect({ who: f.who, audit }).toEqual({
        who: f.who,
        audit: f.own ? [{ action: 'rls.probe.d' }] : [],
      });
    }
  });

  maybeIt(
    'memberships is unreachable through the API for every caller',
    async () => {
      const callers = {
        'admin of C': apiClient(mintJwt(P.adminC)),
        'admin of D': apiClient(mintJwt(P.adminD)),
        stranger: apiClient(mintJwt(P.stranger)),
        anon: apiClient(),
      };
      for (const [who, client] of Object.entries(callers)) {
        const { data, error } = await client.from('memberships').select('*');
        expect({
          who,
          code: (error as { code?: string } | null)?.code,
          data,
        }).toEqual({
          who,
          code: '42501',
          data: null,
        });
        const { error: insertError } = await client.from('memberships').insert({
          user_id: P.stranger,
          tenant_id: P.tenantC,
          role: 'company_admin',
          status: 'active',
        });
        expect((insertError as { code: string }).code).toBe('42501');
        const { error: updateError } = await client
          .from('memberships')
          .update({ role: 'company_admin' })
          .eq('user_id', P.viewerC);
        expect((updateError as { code: string }).code).toBe('42501');
      }
      // The viewer is still a viewer.
      const { data: row } = await service
        .from('memberships')
        .select('role')
        .eq('user_id', P.viewerC)
        .single();
      expect((row as { role: string }).role).toBe('viewer');
    },
  );

  maybeIt(
    "audit_log: only the same company's admin reads it, nobody writes through the API, and rows are append-only",
    async () => {
      const reads: [string, ReturnType<typeof apiClient>, string[]][] = [
        ['admin of C', apiClient(mintJwt(P.adminC)), ['rls.probe.c']],
        ['admin of D', apiClient(mintJwt(P.adminD)), ['rls.probe.d']],
        ['employee of C', apiClient(mintJwt(P.employeeC)), []],
        ['viewer of C', apiClient(mintJwt(P.viewerC)), []],
        ['stranger', apiClient(mintJwt(P.stranger)), []],
      ];
      for (const [who, client, expected] of reads) {
        const { data, error } = await client
          .from('audit_log')
          .select('action, tenant_id');
        expect(error).toBeNull();
        expect({
          who,
          actions: (data as { action: string }[]).map((r) => r.action),
        }).toEqual({ who, actions: expected });
      }
      // No token: anon has no grant at all.
      const { error: anonError } = await apiClient()
        .from('audit_log')
        .select('*');
      expect((anonError as { code: string }).code).toBe('42501');

      // Writes through the API: refused for the admin too.
      const admin = apiClient(mintJwt(P.adminC));
      const { error: insertError } = await admin.from('audit_log').insert({
        actor_user_id: P.adminC,
        actor_is_platform_admin: false,
        tenant_id: P.tenantC,
        action: 'forged',
      });
      expect((insertError as { code: string }).code).toBe('42501');
      const { error: updateError } = await admin
        .from('audit_log')
        .update({ action: 'rewritten' })
        .eq('tenant_id', P.tenantC);
      expect((updateError as { code: string }).code).toBe('42501');
      const { error: deleteError } = await admin
        .from('audit_log')
        .delete()
        .eq('tenant_id', P.tenantC);
      expect((deleteError as { code: string }).code).toBe('42501');

      // Even the service role cannot edit or remove a row (privilege revoked).
      const { error: serviceUpdate } = await service
        .from('audit_log')
        .update({ action: 'rewritten' })
        .eq('tenant_id', P.tenantC);
      expect(['42501', 'PT403']).toContain(
        (serviceUpdate as { code: string }).code,
      );
      const { error: serviceDelete } = await service
        .from('audit_log')
        .delete()
        .eq('tenant_id', P.tenantC);
      expect(['42501', 'PT403']).toContain(
        (serviceDelete as { code: string }).code,
      );

      // The trigger itself, as the table owner (privileges cannot help here):
      // update and delete of the probe's own row stop with PT403.
      const pg = new Client({
        connectionString: process.env['DATABASE_URL'],
        ssl: { rejectUnauthorized: false },
      });
      await pg.connect();
      try {
        for (const sql of [
          "update public.audit_log set action = 'rewritten' where action = 'rls.probe.c'",
          "delete from public.audit_log where action = 'rls.probe.c'",
        ]) {
          await expect(pg.query(sql)).rejects.toMatchObject({ code: 'PT403' });
        }
      } finally {
        await pg.end();
      }
      const { data: intact } = await service
        .from('audit_log')
        .select('action')
        .eq('tenant_id', P.tenantC);
      expect(intact).toEqual([{ action: 'rls.probe.c' }]);
    },
    60000,
  );
});
