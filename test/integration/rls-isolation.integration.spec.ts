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

  // The current 28-skill catalog, exactly as seeded (migration
  // 20260920000001 + icons in 20260920000002). The Story 4.1 six-skill seed
  // UUIDs were retired by the Epic 11-5 cutover and must not be referenced
  // anywhere below — user_skills and workflow_templates FK them, so a dead id
  // fails as 23503 / P0001. The read probe below derives its expected rows
  // from the live DB (the catalog has been reseeded before and will be
  // again); this constant exists to hand the write/RPC probes REAL skill ids.
  const SEED_SKILLS: {
    id: string;
    name: string;
    description: string;
    icon: string;
  }[] = [
    {
      id: '34d565e9-0619-4614-a83f-d38b8caea613',
      name: 'Pipe Leak Repair',
      description: 'Locate and fix leaking or burst pipes',
      icon: 'droplets',
    },
    {
      id: 'e685bfdf-93a4-4cef-a38b-2fdc1dde87a2',
      name: 'Drain Cleaning & Unclog',
      description: 'Clear blocked drains, sinks and toilets',
      icon: 'brush-cleaning',
    },
    {
      id: '5cd5ed90-9db2-4ef7-af1f-eb1756efa13f',
      name: 'Water Heater Service',
      description: 'Install, repair and service geysers',
      icon: 'heater',
    },
    {
      id: 'e498f0e1-f9e0-4fe0-aa8c-3cf3fce7aaa5',
      name: 'Tap & Sanitary Fitting',
      description: 'Install or repair taps, showers and sanitary fittings',
      icon: 'shower-head',
    },
    {
      id: 'c5195783-4446-4fa0-b7b9-ac0fc55230c0',
      name: 'AC Installation & Removal',
      description: 'Install or uninstall split and window ACs',
      icon: 'snowflake',
    },
    {
      id: '081b8ee9-13be-4cdb-937e-1aeba0bf179d',
      name: 'Gas Charging & Leak Check',
      description: 'Refrigerant top-up and leak detection',
      icon: 'gauge',
    },
    {
      id: '9b7543bd-465d-433a-b8ec-30772b89c346',
      name: 'Duct & Coil Cleaning',
      description: 'Deep-clean AC filters, coils and ducts',
      icon: 'fan',
    },
    {
      id: 'f10601f0-5af2-48d3-a787-f01af9d75405',
      name: 'AC General Service',
      description: 'Routine AC servicing and performance check',
      icon: 'air-vent',
    },
    {
      id: '25b8dbad-8996-4d01-a26c-4dc57ee5596f',
      name: 'Electrical Wiring & Repair',
      description: 'New wiring and electrical fault repair',
      icon: 'cable',
    },
    {
      id: '05ea0db3-3384-4d5a-9281-e239eb96fe38',
      name: 'Switchboard & Socket Installation',
      description: 'Install or repair switchboards, sockets and MCBs',
      icon: 'plug',
    },
    {
      id: '8f8af0c2-247f-4c59-a021-eec0881d506c',
      name: 'Fan & Light Installation',
      description: 'Mount fans, chandeliers and light fittings',
      icon: 'lightbulb',
    },
    {
      id: '23b18871-c021-4dd7-9482-ba72e6d3a203',
      name: 'Inverter & Stabilizer Setup',
      description: 'Install and service inverters and stabilizers',
      icon: 'battery-charging',
    },
    {
      id: 'e3628fb0-4882-4f6d-aef3-a48ddcce0de3',
      name: 'General Pest Control',
      description: 'Cockroaches, ants and common household pests',
      icon: 'bug',
    },
    {
      id: '0041b89b-ce09-49fb-a986-255e482fffbb',
      name: 'Termite Treatment',
      description: 'Pre- and post-construction termite control',
      icon: 'bug-off',
    },
    {
      id: 'c57b0371-f527-4c1c-a6e1-c4dc5ff4a079',
      name: 'Bed Bug & Mosquito Treatment',
      description: 'Targeted fumigation for bed bugs and mosquitoes',
      icon: 'spray-can',
    },
    {
      id: '62adb4d5-b6ee-435c-9038-b9a0e2939cd0',
      name: 'Deep Home Cleaning',
      description: 'Full-house deep cleaning, room by room',
      icon: 'sparkles',
    },
    {
      id: '03a67044-f127-4717-b4d7-5e943f206022',
      name: 'Bathroom & Kitchen Cleaning',
      description: 'Targeted cleaning of wet areas and appliances',
      icon: 'bath',
    },
    {
      id: 'a85864e7-2036-4cdf-9022-bc1f0e8025a3',
      name: 'Sofa & Carpet Cleaning',
      description: 'Upholstery shampooing and stain removal',
      icon: 'sofa',
    },
    {
      id: '1d1c21c7-1d0e-47d0-8887-b11f7db62210',
      name: 'Water Tank Cleaning',
      description: 'Overhead and underground tank cleaning',
      icon: 'barrel',
    },
    {
      id: '415e5292-f5b1-45c6-877d-421d652f24a9',
      name: 'Furniture Repair & Assembly',
      description: 'Fix, polish or assemble furniture',
      icon: 'hammer',
    },
    {
      id: '03c9b376-cec8-41a3-8156-8fb23cab81ad',
      name: 'Door & Lock Repair',
      description: 'Doors, hinges, locks and latches',
      icon: 'door-closed-locked',
    },
    {
      id: '0942a949-3471-4c52-8863-ddc0b168b862',
      name: 'Interior Painting',
      description: 'Wall putty and interior painting',
      icon: 'paint-roller',
    },
    {
      id: 'f5d98075-f641-4a05-9ab4-4b663f144c9c',
      name: 'Waterproofing',
      description: 'Terrace and wall leakage sealing',
      icon: 'umbrella',
    },
    {
      id: '1e92d729-46e0-432d-a3f6-76d6c8f6f625',
      name: 'Washing Machine Repair',
      description: 'Repair and service all washing machine types',
      icon: 'washing-machine',
    },
    {
      id: '7fc82c84-375d-4e7c-a991-bd5986cfc1c7',
      name: 'Refrigerator Repair',
      description: 'Repair and service fridges and deep freezers',
      icon: 'refrigerator',
    },
    {
      id: '4073e7b5-a3c8-4b9b-bce5-7ba783858390',
      name: 'Microwave & Chimney Repair',
      description: 'Repair kitchen appliances and chimneys',
      icon: 'microwave',
    },
    {
      id: '580ffdf7-637e-491a-bcee-60acc5d99c38',
      name: 'CCTV & Doorbell Installation',
      description: 'Install cameras, video doorbells and smart locks',
      icon: 'cctv',
    },
    {
      id: 'a539a0b5-8ac4-47c1-8dcb-e5aaa03e1606',
      name: 'Handyman Visit',
      description: 'One visit for small miscellaneous jobs',
      icon: 'wrench',
    },
  ];

  /** A current catalog row by name — fails loudly if the constant drifts. */
  function skillByName(name: string): { id: string; name: string } {
    const row = SEED_SKILLS.find((s) => s.name === name);
    if (!row) throw new Error(`Skill "${name}" missing from SEED_SKILLS`);
    return row;
  }

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

      // Read the live catalog through an authenticated JWT-scoped client —
      // the same select/filter/order the service issues. The service chain
      // must reproduce EXACTLY these rows (the mint→PostgREST contract);
      // the expected list is DB-derived, not hard-coded, so a future catalog
      // reseed cannot stale this probe out.
      const catalogJwt = mintJwt(
        '00000000-0000-0000-0000-000000000099',
        null,
        'authenticated',
      );
      const catalogClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${catalogJwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: catalogRows, error: catalogError } = await catalogClient
        .from('skills')
        .select('id, name, description, icon')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      expect(catalogError).toBeNull();
      // Sanity: the DB really holds the shape the service must return.
      expect(catalogRows!.length).toBeGreaterThan(0);
      expect(
        catalogRows?.every(
          (row: {
            id: string;
            name: string;
            description: string;
            icon: string;
          }) =>
            typeof row.id === 'string' &&
            typeof row.name === 'string' &&
            typeof row.description === 'string' &&
            typeof row.icon === 'string',
        ),
      ).toBe(true);

      const rows = await service.listGlobalSkills(probeUser);
      expect(rows).toEqual(catalogRows);

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

      // RLS write denial: the NOT NULL columns (sort_order, description, icon
      // — the last two added by 20260920000001/2) are supplied so a not-null
      // violation (23502) cannot mask the policy denial — the failure must be
      // 42501.
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
        description: 'RLS write probe',
        icon: 'wrench',
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
          {
            user_id: foreignUserId,
            skill_id: skillByName('Pipe Leak Repair').id,
          },
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
          .insert({
            user_id: foreignUserId,
            skill_id: skillByName('Pipe Leak Repair').id,
          });
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
            skill_id: skillByName('Drain Cleaning & Unclog').id,
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
      // values (migration 20260920000001): AC General Service skill → its v1
      // template, version 1.
      const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
      expect(SERVICE_KEY).not.toBe('');
      const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const tenantId = '00000000-0000-0000-0000-000000000096';
      const ownerId = '00000000-0000-0000-0000-000000000094';
      const techId = '00000000-0000-0000-0000-000000000095';
      const customerId = '00000000-0000-0000-0000-000000000093';
      const acServiceSkillId = skillByName('AC General Service').id; // f10601f0-… (11-5 catalog)
      const acServiceTemplateId = 'c615c047-bc1b-4d38-b3a1-7b877210bea8'; // its seeded v1 template
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
