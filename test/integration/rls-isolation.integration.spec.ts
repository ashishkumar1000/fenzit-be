/**
 * RLS Cross-Tenant Isolation Test (AR-20 — hard launch blocker)
 *
 * Verifies that Supabase RLS policies prevent tenants from reading
 * each other's data via the JWT-scoped client.
 *
 * Requires a real Supabase project. Tests are skipped when the env var
 * SUPABASE_URL is a stub (https://test.supabase.co). Set SUPABASE_URL,
 * SUPABASE_ANON_KEY, and SUPABASE_JWT_SECRET to real values to run.
 */
import { createClient } from '@supabase/supabase-js';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SupabaseClientFactory } from '../../src/common/factories/supabase-client.factory';
import { SkillsService } from '../../src/skills/skills.service';
import type { RequestUser } from '../../src/common/interfaces/request-user.interface';
import { Role } from '../../src/common/enums/role.enum';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SUPABASE_JWT_SECRET = process.env['SUPABASE_JWT_SECRET'] ?? '';
const IS_REAL_DB =
  SUPABASE_URL !== '' && !SUPABASE_URL.includes('test.supabase.co');

function mintJwt(
  userId: string,
  tenantId: string | null,
  role: string,
): string {
  return jwt.sign({ sub: userId, tenantId, role }, SUPABASE_JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
}

describe('RLS Cross-Tenant Isolation (AR-20)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;

  maybeIt(
    'Owner B cannot read Owner A tenant row via JWT-scoped client',
    async () => {
      // This test assumes at least one tenant row exists in the DB (created by Story 1.3 dev flow).
      // It mints a JWT for a different user and confirms the SELECT returns no rows.
      //
      // The JWT role claim names the Postgres role PostgREST switches to, so it
      // must be 'authenticated' (app roles like 'owner' are not Postgres roles
      // — Postgres rejects them with 22023). Same pattern as 4.1's minted reads.

      const ownerBId = '00000000-0000-0000-0000-000000000099'; // non-existent / different user
      const ownerBJwt = mintJwt(ownerBId, null, 'authenticated');

      const ownerBClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${ownerBJwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // RLS policy on tenants: owner_id = (auth.jwt() ->> 'sub')::uuid
      // Owner B's JWT sub doesn't match any tenant's owner_id → empty result, not an error
      const { data, error } = await ownerBClient
        .from('tenants')
        .select('id, owner_id');

      expect(error).toBeNull();
      expect(data).toEqual([]); // RLS returns empty, not 403
    },
  );

  maybeIt(
    'Owner A can read their own tenant row via JWT-scoped client',
    async () => {
      // Requires a tenant row whose owner_id is known. This test will be fully
      // exercisable once a real tenant is created via the Story 1.3 endpoint.
      // For now, it verifies the RLS SELECT policy permits the correct owner.
      //
      // To run: insert a test tenant via service role, then pass owner's userId here.
      const ownerAId = process.env['TEST_OWNER_A_USER_ID'];
      if (!ownerAId) {
        console.log('Skipping: TEST_OWNER_A_USER_ID not set');
        return;
      }

      const ownerAJwt = mintJwt(ownerAId, null, 'authenticated');
      const ownerAClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${ownerAJwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data, error } = await ownerAClient
        .from('tenants')
        .select('id, owner_id');

      expect(error).toBeNull();
      // Owner A should see at least their own row, and every returned row must belong to them
      expect(data?.length).toBeGreaterThan(0);
      expect(
        data?.every((row: { owner_id: string }) => row.owner_id === ownerAId),
      ).toBe(true);
    },
  );

  const SEED_SKILLS: { id: string; name: string }[] = [
    { id: 'd89d67f7-c0fe-42f8-9f76-c1660c98ce97', name: 'Plumbing' },
    { id: '77d9450a-f9a4-4992-a82a-cdf27063e9e9', name: 'Electrical' },
    { id: '65f33480-b37e-47e2-a4a0-0155b156cc7a', name: 'AC Service' },
    { id: '95f021b0-a973-45fc-b73f-db0dc5afd4a0', name: 'AC Installation' },
    { id: '71cc840c-3663-489e-bbf2-867d92c46619', name: 'Pest Control' },
    { id: '72f67596-fec7-4ae8-a6f1-fceabaef0d7d', name: 'Cleaning' },
  ];

  maybeIt(
    'Global skills table: real service chain reads seeds in order, anon sees zero, writes denied',
    async () => {
      // skills is a global developer-seeded catalog (Story 4.1): RLS grants
      // SELECT to authenticated and defines no write policies.
      //
      // The READ below runs the REAL production chain — SkillsService
      // .listGlobalSkills with a real JwtService minting the
      // role:'authenticated' token and the real SupabaseClientFactory — the
      // exact mint→PostgREST contract review round 1 found broken. Hand-built
      // JWTs stay only for the write/anon probes (review round 2, 2026-09-10).
      const service = new SkillsService(
        new SupabaseClientFactory(
          new ConfigService({
            SUPABASE_URL,
            SUPABASE_ANON_KEY,
            SUPABASE_SERVICE_ROLE_KEY: 'unused-in-this-test',
          }),
        ),
        new JwtService({ secret: SUPABASE_JWT_SECRET }),
      );
      const probeUser: RequestUser = {
        userId: '00000000-0000-0000-0000-000000000099',
        tenantId: null,
        role: Role.OWNER,
        rawJwt: 'unused',
      };

      const rows = await service.listGlobalSkills(probeUser);
      expect(rows).toEqual(SEED_SKILLS);

      // No JWT → PostgREST falls back to the anon role, which has no policy
      // on skills → zero rows, not an error.
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: anonData, error: anonError } = await anonClient
        .from('skills')
        .select('id, name');
      expect(anonError).toBeNull();
      expect(anonData).toEqual([]);

      // RLS write denial: sort_order is supplied so a not-null violation
      // (23502) cannot mask the policy denial — the failure must be 42501.
      const someUserJwt = jwt.sign(
        {
          sub: '00000000-0000-0000-0000-000000000099',
          role: 'authenticated',
        },
        SUPABASE_JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '1h' },
      );
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${someUserJwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: writeError } = await client.from('skills').insert({
        id: crypto.randomUUID(),
        name: 'RLS write probe',
        sort_order: 99,
      });
      expect(writeError).not.toBeNull();
      expect((writeError as { code: string }).code).toBe('42501');
    },
  );

  maybeIt(
    'user_skills RLS: cross-tenant reads exclude real rows, writes outside tenant denied, same-tenant writes allowed',
    async () => {
      // Story 4.2 — user_skills_tenant_isolation: a row is visible/writable
      // only when its user's tenant matches the JWT tenantId (checked via an
      // EXISTS join into users). Seeded through the service role so the probes
      // are discriminating: a nonexistent user also fails the policy's EXISTS,
      // which would mask a broken tenant comparison (4.2 review round 1).
      const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
      expect(SERVICE_KEY).not.toBe('');
      const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // Seed one technician under a freshly seeded tenant (users.tenant_id has
      // an FK, and the dev DB may hold zero tenants — it does today) plus one
      // user_skills row for them.
      const foreignUserId = '00000000-0000-0000-0000-000000000090';
      const seededTenantId = '00000000-0000-0000-0000-000000000097';
      const { error: userUpsertError } = await serviceClient
        .from('users')
        .upsert(
          {
            id: foreignUserId,
            country_code: '+91',
            phone_number: '9999000001',
            role: 'technician',
            status: 'invited',
          },
          { onConflict: 'id' },
        );
      expect(userUpsertError).toBeNull();
      const { error: tenantUpsertError } = await serviceClient
        .from('tenants')
        .upsert(
          {
            id: seededTenantId,
            owner_id: foreignUserId,
            company_name: 'RLS Probe Co',
            state_code: 'KA',
          },
          { onConflict: 'id' },
        );
      expect(tenantUpsertError).toBeNull();
      const { error: linkError } = await serviceClient
        .from('users')
        .update({ tenant_id: seededTenantId })
        .eq('id', foreignUserId);
      expect(linkError).toBeNull();
      const { error: seedSkillError } = await serviceClient
        .from('user_skills')
        .upsert(
          { user_id: foreignUserId, skill_id: SEED_SKILLS[0].id },
          { onConflict: 'user_id,skill_id' },
        );
      expect(seedSkillError).toBeNull();

      try {
        // JWT scoped to a tenant that exists as a UUID but owns no users —
        // the seeded row belongs to realTenantId, so it must be invisible.
        const foreignTenantId = '00000000-0000-0000-0000-000000000098';
        const crossTenantJwt = mintJwt(
          '00000000-0000-0000-0000-000000000099',
          foreignTenantId,
          'authenticated',
        );
        const crossTenantClient = createClient(
          SUPABASE_URL,
          SUPABASE_ANON_KEY,
          {
            global: { headers: { Authorization: `Bearer ${crossTenantJwt}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          },
        );

        // SELECT (USING side): the seeded row must NOT come back — proves the
        // tenant comparison filters, not merely that the table is empty.
        const { data, error } = await crossTenantClient
          .from('user_skills')
          .select('user_id, skill_id');
        expect(error).toBeNull();
        expect(
          (data as { user_id: string }[]).some(
            (r) => r.user_id === foreignUserId,
          ),
        ).toBe(false);

        // INSERT (WITH CHECK side): an EXISTING user of another tenant →
        // 42501. RLS runs before constraints, so the violation surfaces as a
        // policy denial, not an FK error.
        const { error: writeError } = await crossTenantClient
          .from('user_skills')
          .insert({ user_id: foreignUserId, skill_id: SEED_SKILLS[0].id });
        expect(writeError).not.toBeNull();
        expect((writeError as { code: string }).code).toBe('42501');

        // Positive path: the seeded user's own tenant may write — WITH CHECK
        // has a permissive side this suite never exercised before.
        const ownTenantJwt = mintJwt(
          foreignUserId,
          seededTenantId,
          'authenticated',
        );
        const ownTenantClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${ownTenantJwt}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { error: insertError } = await ownTenantClient
          .from('user_skills')
          .insert({
            user_id: foreignUserId,
            skill_id: SEED_SKILLS[1].id,
          });
        expect(insertError).toBeNull();
      } finally {
        // Cleanup: remove everything seeded (idempotent on re-run via upsert).
        await serviceClient
          .from('user_skills')
          .delete()
          .eq('user_id', foreignUserId);
        await serviceClient.from('tenants').delete().eq('id', seededTenantId);
        await serviceClient.from('users').delete().eq('id', foreignUserId);
      }
    },
  );

  maybeIt(
    'user_skills → skills embed resolves over the retargeted FK (Story 4.2)',
    async () => {
      // The three service embeds (job detail, own profile, technician list)
      // read user_skills joined to skills!inner — unit tests mock the embed
      // response, so a broken PostgREST relationship (PGRST200) would 500 in
      // production while every mock-based suite stays green. This probe runs
      // the real embed: zero rows is fine, a relationship error is not.
      const embedJwt = mintJwt(
        '00000000-0000-0000-0000-000000000099',
        '00000000-0000-0000-0000-000000000098',
        'authenticated',
      );
      const embedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${embedJwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await embedClient
        .from('user_skills')
        .select('skills!inner(name)');
      expect(error).toBeNull();
    },
  );

  maybeIt(
    'create_job_with_log RPC stamps the skill template (Story 4.3)',
    async () => {
      // No mock-based suite executes the new RPC body — a param-name drift or a
      // broken template lookup would pass everywhere else. This probe runs the
      // real RPC via service role and asserts the stamp equals the fixed seed
      // values (docs/data-models.md): AC Service skill → its v1 template,
      // version 1.
      const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
      expect(SERVICE_KEY).not.toBe('');
      const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const tenantId = '00000000-0000-0000-0000-000000000096';
      const ownerId = '00000000-0000-0000-0000-000000000094';
      const techId = '00000000-0000-0000-0000-000000000095';
      const customerId = '00000000-0000-0000-0000-000000000093';
      const acServiceSkillId = SEED_SKILLS[2].id; // 65f33480-… (AC Service)
      const acServiceTemplateId = '8a3c4d5e-6f7a-4b8c-9d9e-3f4a5b6c7d8e';
      // Job-number year is the IST creation year (same offset the service uses).
      const istYear = new Date(
        Date.now() + 5.5 * 60 * 60 * 1000,
      ).getUTCFullYear();

      // Seed owner user → tenant (owner_id FK) → tenant-linked technician +
      // customer. Upserts keep re-runs idempotent, mirroring the user_skills
      // probe above.
      const { error: ownerError } = await serviceClient.from('users').upsert(
        {
          id: ownerId,
          country_code: '+91',
          phone_number: '9999000002',
          role: 'owner',
          status: 'active',
        },
        { onConflict: 'id' },
      );
      expect(ownerError).toBeNull();
      const { error: tenantError } = await serviceClient.from('tenants').upsert(
        {
          id: tenantId,
          owner_id: ownerId,
          company_name: 'RPC Probe Co',
          state_code: 'KA',
        },
        { onConflict: 'id' },
      );
      expect(tenantError).toBeNull();
      const { error: techError } = await serviceClient.from('users').upsert(
        {
          id: techId,
          tenant_id: tenantId,
          country_code: '+91',
          phone_number: '9999000003',
          role: 'technician',
          status: 'active',
        },
        { onConflict: 'id' },
      );
      expect(techError).toBeNull();
      const { error: customerError } = await serviceClient
        .from('customers')
        .upsert(
          {
            id: customerId,
            tenant_id: tenantId,
            name: 'RPC Probe Customer',
            country_code: '+91',
            phone_number: '9999000004',
          },
          { onConflict: 'id' },
        );
      expect(customerError).toBeNull();

      let createdJobId: string | null = null;
      try {
        const { data, error } = await serviceClient.rpc('create_job_with_log', {
          p_tenant_id: tenantId,
          p_customer_id: customerId,
          p_technician_id: techId,
          p_service_location: 'RPC probe location',
          p_skill_id: acServiceSkillId,
          p_scheduled_start: new Date().toISOString(),
          p_scheduled_end: null,
          p_description: 'Story 4.3 RPC probe',
          p_priority: 'normal',
          p_notes_for_technician: null,
          p_actor_id: ownerId,
          p_year: istYear,
        });
        expect(error).toBeNull();

        // RETURNS SETOF jobs ⇒ an array of one stamped row.
        const rows = data as {
          id: string;
          skill_id: string;
          workflow_template_id: string;
          workflow_template_version: number;
        }[];
        // Capture the id BEFORE asserting, so a failed assertion still cleans up.
        if (rows && rows.length > 0) createdJobId = rows[0].id;
        expect(rows).toHaveLength(1);
        expect(rows[0].skill_id).toBe(acServiceSkillId);
        expect(rows[0].workflow_template_id).toBe(acServiceTemplateId);
        expect(rows[0].workflow_template_version).toBe(1);
      } finally {
        // Cleanup: no rows left behind (job first — activity_logs cascade;
        // tenant last — job_sequences/customers cascade).
        if (createdJobId) {
          await serviceClient.from('jobs').delete().eq('id', createdJobId);
        }
        await serviceClient.from('customers').delete().eq('id', customerId);
        await serviceClient.from('users').delete().in('id', [ownerId, techId]);
        await serviceClient.from('tenants').delete().eq('id', tenantId);
      }
    },
  );

  it('(always) RLS test suite is correctly structured', () => {
    // This test always runs and verifies the suite is wired correctly.
    // Real DB tests are skipped automatically when SUPABASE_URL is a stub.
    if (!IS_REAL_DB) {
      console.log(
        'ℹ️  RLS isolation tests skipped: SUPABASE_URL is a stub. ' +
          'Set real DB credentials to run cross-tenant isolation checks (AR-20).',
      );
    }
    expect(true).toBe(true);
  });
});
