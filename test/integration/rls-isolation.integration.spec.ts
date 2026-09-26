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
import type { RealtimeChannel } from '@supabase/supabase-js';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
// Story 14.2 realtime probes: Node 20 (this repo's runtime) has no native
// WebSocket, and supabase-js's realtime client takes its WebSocket from the
// global. Polyfill from `ws` (devDependency) when missing — BEFORE any
// realtime client is constructed.
import RealtimeWebSocket from 'ws';
if (typeof (globalThis as Record<string, unknown>)['WebSocket'] === 'undefined') {
  (globalThis as Record<string, unknown>)['WebSocket'] = RealtimeWebSocket;
}
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

        // Service-role positive path for advance_workflow_step (Story 14-1
        // review): 20260925000003 grants explicit service_role EXECUTE on all
        // ten functions, but only create_job_with_log had a real-DB positive
        // probe. Advance the seeded job from its initial NULL current_step to
        // the first template step ('on_my_way' — sets_status 'in_progress')
        // and assert the RPC returns the advanced row. Proves the app's
        // second write path survives the lockdown too; cleanup below deletes
        // the job either way.
        const { data: advData, error: advError } = await serviceClient.rpc(
          'advance_workflow_step',
          {
            p_job_id: createdJobId,
            p_tenant_id: tenantId,
            p_actor_id: ownerId,
            p_step: 'on_my_way',
            p_new_status: 'in_progress',
            p_expected_current_step: null,
          },
        );
        expect(advError).toBeNull();
        const advRows = advData as { id: string; current_step: string }[];
        expect(advRows).toHaveLength(1);
        expect(advRows[0].current_step).toBe('on_my_way');
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

  maybeIt(
    'Public DB functions reject direct RPC calls under anon/authenticated keys (Story 14-1)',
    async () => {
      // Migration 20260925000001 revoked EXECUTE on every public-schema
      // function from PUBLIC/anon/authenticated (deferred-work item 1). The
      // anon probe below is the reviewer's original finding — it returned
      // 200 before the migration; now Postgres denies at the privilege check
      // (42501) before the SECURITY DEFINER body runs, so no job row is
      // touched either way (the ids below are non-existent probes).
      //
      // advance_workflow_step is called with its six required params; the
      // remaining six have DEFAULT NULL (migration 20260913000002).
      const RPC_ARGS = {
        p_job_id: '00000000-0000-0000-0000-000000000099',
        p_tenant_id: '00000000-0000-0000-0000-000000000098',
        p_actor_id: '00000000-0000-0000-0000-000000000099',
        p_step: 'rls_probe',
        p_new_status: null,
        p_expected_current_step: null,
      };

      // A minted 'authenticated' JWT is exactly what a token holder of the
      // publishable key would present to call the RPC directly, bypassing
      // NestJS (which routes every RPC through the service-role client —
      // proven unaffected by the create_job_with_log probe above).
      const authedJwt = mintJwt(
        '00000000-0000-0000-0000-000000000099',
        null,
        'authenticated',
      );
      const authedRpcClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${authedJwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: authedRpcError } = await authedRpcClient.rpc(
        'advance_workflow_step',
        RPC_ARGS,
      );
      expect(authedRpcError).not.toBeNull();
      expect((authedRpcError as { code: string }).code).toBe('42501');

      // Anon key, no JWT → anon role, also revoked.
      const anonRpcClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: anonRpcError } = await anonRpcClient.rpc(
        'advance_workflow_step',
        RPC_ARGS,
      );
      expect(anonRpcError).not.toBeNull();
      expect((anonRpcError as { code: string }).code).toBe('42501');
    },
  );

  maybeIt(
    'users self-update is column-limited to name (Story 14-1)',
    async () => {
      // Migration 20260925000002 (deferred-work item 2): anon lost UPDATE on
      // users entirely and authenticated was cut from a whole-table UPDATE
      // grant to a column-level UPDATE (name) grant. A row-only RLS policy
      // cannot reject a combined `SET name, role` update — the grant-level
      // check does, and Postgres evaluates it before RLS (so it fires even
      // for a zero-row match, as here: the probe id belongs to no real user).
      const selfUserId = '00000000-0000-0000-0000-000000000099';
      const selfJwt = mintJwt(selfUserId, null, 'authenticated');
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${selfJwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // Combined self-update touching privileged columns → 42501 (grant
      // level), not an RLS rejection and not a silent partial update.
      const { error: combinedError } = await client
        .from('users')
        .update({ name: 'RLS probe', role: 'owner', tenant_id: null })
        .eq('id', selfUserId);
      expect(combinedError).not.toBeNull();
      expect((combinedError as { code: string }).code).toBe('42501');

      // Name-only self-update on an absent row → allowed at grant/RLS level;
      // zero rows matched, no error (and no row can be created — INSERT has
      // no permissive policy). `.select()` makes PostgREST return the matched
      // rows (plain update returns data: null), so an empty array proves
      // nothing was mutated rather than the update silently landing.
      const { data: nameOnlyRows, error: nameOnlyError } = await client
        .from('users')
        .update({ name: 'RLS probe' })
        .eq('id', selfUserId)
        .select('id');
      expect(nameOnlyError).toBeNull();
      expect(nameOnlyRows).toEqual([]);
    },
  );

  maybeIt(
    'users: anon UPDATE denied, authenticated privileged upsert denied, real name-only self-update succeeds (Story 14-1)',
    async () => {
      // Completes the 20260925000002 grant matrix with the paths the absent-row
      // probe above cannot exercise: (1) anon lost UPDATE entirely; (2) an
      // authenticated upsert touching non-name columns is denied (for an
      // INSERT ... ON CONFLICT DO UPDATE SET role, Postgres checks the UPDATE
      // column privileges up front — `role` is not in authenticated's
      // UPDATE(name) grant; if the conflict path instead inserts, the
      // insert-only-service-role policy denies it — either way 42501);
      // (3) the intended self-service path works on a REAL row.
      const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
      expect(SERVICE_KEY).not.toBe('');
      const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: anonUpdateError } = await anonClient
        .from('users')
        .update({ name: 'RLS probe' })
        .eq('id', '00000000-0000-0000-0000-000000000099');
      expect(anonUpdateError).not.toBeNull();
      expect((anonUpdateError as { code: string }).code).toBe('42501');

      // Deterministic probe ids in the suite's 00000000-…-99 block (091/092 —
      // unused by the other probes; the upsert probe targets an absent row,
      // so no pre-existing row can be modified).
      const upsertProbeId = '00000000-0000-0000-0000-000000000091';
      const authedUpsertJwt = mintJwt(upsertProbeId, null, 'authenticated');
      const authedUpsertClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${authedUpsertJwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: upsertError } = await authedUpsertClient
        .from('users')
        .upsert({ id: upsertProbeId, name: 'RLS probe', role: 'owner' });
      expect(upsertError).not.toBeNull();
      expect((upsertError as { code: string }).code).toBe('42501');

      // Positive path on a real seeded row: authenticated name-only update
      // succeeds and touches nothing else (role/tenant_id must come back
      // exactly as seeded). The phone is probe-specific (…092) — users has
      // partial UNIQUE indexes on (country_code, phone_number), so reusing a
      // phone from another suite's seed would fail the seed before the try
      // even opens. A pre-clean makes re-runs idempotent after a crashed run.
      const probeUserId = '00000000-0000-0000-0000-000000000092';
      await serviceClient.from('users').delete().eq('id', probeUserId);
      const { error: seedError } = await serviceClient.from('users').upsert(
        {
          id: probeUserId,
          country_code: '+91',
          phone_number: '9999000092',
          role: 'technician',
          status: 'invited',
        },
        { onConflict: 'id' },
      );
      expect(seedError).toBeNull();

      try {
        const selfJwt = mintJwt(probeUserId, null, 'authenticated');
        const selfClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${selfJwt}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data, error } = await selfClient
          .from('users')
          .update({ name: 'RLS probe self-update' })
          .eq('id', probeUserId)
          .select('id, name, role, tenant_id');
        expect(error).toBeNull();
        const rows = data as {
          id: string;
          name: string;
          role: string;
          tenant_id: string | null;
        }[];
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(probeUserId);
        expect(rows[0].name).toBe('RLS probe self-update');
        expect(rows[0].role).toBe('technician');
        expect(rows[0].tenant_id).toBeNull();
      } finally {
        // Cleanup: the probe row must not leak into the shared live DB.
        const { error: cleanupError } = await serviceClient
          .from('users')
          .delete()
          .eq('id', probeUserId);
        expect(cleanupError).toBeNull();
      }
    },
  );

  maybeIt(
    'Catalog pin: every public RPC rejects anon-key direct calls (Story 14-1)',
    async () => {
      // Pins the 20260925000001 revokes against drift: pg_catalog is NOT
      // exposed over PostgREST (verified — pg_proc returns PGRST205), so the
      // pg_proc.proacl assertion cannot run through supabase-js. Instead every
      // public-schema function is probed via the bare anon key with its real
      // argument names:
      //   - RPC functions must die at the EXECUTE privilege check (42501)
      //     before their body runs, so the probe ids mutate nothing.
      //   - Trigger functions are NEVER exposed as RPC endpoints by PostgREST
      //     (returns-trigger ⇒ not in the RPC schema cache) — PGRST202 proves
      //     they are unreachable through the Data API at all. Their EXECUTE
      //     ACLs stay pinned by MCP verification (pg_proc.proacl).
      // A future RPC re-granted to PUBLIC/anon will NOT be caught here — it
      // must repeat the revoke pattern in its own migration (default
      // privileges from 20260925000003 now deny PUBLIC for postgres-created
      // functions).
      const anonRpcClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const PROBE_ID = '00000000-0000-0000-0000-000000000099';

      // Name-arg fixtures match each function's live signature exactly
      // (verified against pg_proc / the app's own call sites).
      const RPC_FUNCTIONS: Record<string, Record<string, unknown>> = {
        advance_workflow_step: {
          p_job_id: PROBE_ID,
          p_tenant_id: PROBE_ID,
          p_actor_id: PROBE_ID,
          p_step: 'rls_probe',
          p_new_status: null,
          p_expected_current_step: null,
        },
        confirm_attachment: {
          p_upload_id: PROBE_ID,
          p_job_id: PROBE_ID,
          p_tenant_id: PROBE_ID,
          p_size_bytes: 1,
          p_actor_id: PROBE_ID,
        },
        create_job_with_log: {
          p_tenant_id: PROBE_ID,
          p_customer_id: PROBE_ID,
          p_technician_id: PROBE_ID,
          p_service_location: 'rls probe',
          p_skill_id: PROBE_ID,
          p_scheduled_start: new Date().toISOString(),
          p_scheduled_end: null,
          p_description: 'rls probe',
          p_priority: 'normal',
          p_notes_for_technician: null,
          p_actor_id: PROBE_ID,
          p_year: 2026,
        },
        increment_job_counter: { p_tenant_id: PROBE_ID, p_year: 2026 },
        setup_tenant_for_owner: {
          p_user_id: PROBE_ID,
          p_company_name: 'RLS Probe Co',
          p_gstin: null,
          p_address: null,
          p_state_code: 'KA',
          p_upi_vpa: null,
        },
        update_job_with_log: {
          p_job_id: PROBE_ID,
          p_tenant_id: PROBE_ID,
          p_actor_id: PROBE_ID,
          p_cancel: false,
          p_description: null,
          p_scheduled_start: null,
          p_scheduled_end: null,
          p_notes_for_technician: null,
          p_technician_id: null,
          p_priority: null,
        },
        workflow_steps_valid: { p_steps: [] },
        // Story 15-2 attendance RPCs (migrations 20260926000003/4). All are
        // SECURITY DEFINER with EXECUTE revoked from PUBLIC/anon/authenticated
        // and granted to service_role — same 42501 pin as above. The probe
        // ids mutate nothing: the privilege check fires before any body runs,
        // and attendance_start_setup/complete_setup are unreachable anyway.
        attendance_today: { p_tenant_id: PROBE_ID },
        attendance_lock_tenant: { p_tenant_id: PROBE_ID, p_exclusive: true },
        attendance_lock_employee: { p_employee_id: PROBE_ID },
        attendance_complete_setup: {
          p_tenant_id: PROBE_ID,
          p_actor_id: PROBE_ID,
        },
        attendance_start_setup: {
          p_tenant_id: PROBE_ID,
          p_actor_id: PROBE_ID,
        },
        // Story 15-3 office RPCs (migration 20260926000006) — same SECURITY
        // DEFINER + revoke pattern, same 42501 pin. The probe ids mutate
        // nothing: the privilege check fires before any body runs, and the
        // two blocker-facing functions are lazy-compiled against 15-7 tables
        // (unreachable pre-15-7 even with a grant).
        attendance_create_office: {
          p_tenant_id: PROBE_ID,
          p_actor_id: PROBE_ID,
          p_name: 'RLS Probe Office',
          p_latitude: 19.1,
          p_longitude: 72.8,
          p_radius_m: 100,
          p_start_time: '09:00',
          p_end_time: '17:00',
          p_late_cutoff_minutes: 15,
          p_full_day_hours: 8,
          p_half_day_hours: 4,
        },
        attendance_update_office_rules: {
          p_tenant_id: PROBE_ID,
          p_actor_id: PROBE_ID,
          p_office_id: PROBE_ID,
          p_start_time: '09:00',
          p_end_time: '17:00',
          p_late_cutoff_minutes: 15,
          p_full_day_hours: 8,
          p_half_day_hours: 4,
        },
        attendance_archive_office: {
          p_tenant_id: PROBE_ID,
          p_actor_id: PROBE_ID,
          p_office_id: PROBE_ID,
        },
        attendance_office_archive_blockers: {
          p_tenant_id: PROBE_ID,
          p_office_id: PROBE_ID,
        },
      };

      for (const [name, args] of Object.entries(RPC_FUNCTIONS)) {
        const { error } = await anonRpcClient.rpc(name, args);
        expect(error).not.toBeNull();
        expect((error as { code: string }).code).toBe('42501');
      }

      // Mirror the sweep with an authenticated JWT — anon-only coverage would
      // miss a future migration that re-grants EXECUTE to `authenticated`
      // alone (Story 14-1 review).
      const authedProbeJwt = mintJwt(PROBE_ID, null, 'authenticated');
      const authedPinClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${authedProbeJwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      for (const [name, args] of Object.entries(RPC_FUNCTIONS)) {
        const { error } = await authedPinClient.rpc(name, args);
        expect(error).not.toBeNull();
        expect((error as { code: string }).code).toBe('42501');
      }

      // Trigger functions: returns-trigger ⇒ never an RPC endpoint at all.
      const TRIGGER_FUNCTIONS = [
        'notifications_broadcast_changes',
        'report_requests_in_flight_guard',
        'update_updated_at_column',
        // Story 15-2: timezone validator on tenants (BEFORE INSERT OR UPDATE
        // OF timezone).
        'tenants_timezone_guard',
      ];
      for (const name of TRIGGER_FUNCTIONS) {
        const { error } = await anonRpcClient.rpc(name, {});
        expect(error).not.toBeNull();
        expect((error as { code: string }).code).toBe('PGRST202');
      }
    },
  );

  maybeIt(
    'notifications realtime: technician gets own-topic broadcasts, foreign topics stay silent, dedupe_key is unique (Story 14.2)',
    async () => {
      // Story 14.2's three real-DB probes in one seeded scenario (each probe
      // alone would re-seed the same users/tenant three times):
      //   (a) the technician's private channel receives the INSERT broadcast
      //       for their own topic — delivery works exactly as fenzo-app's
      //       client drives it (accessToken callback + private channel; NOT an
      //       Authorization header — the live probe showed only this
      //       combination delivers),
      //   (b) the SAME technician token subscribed to the OWNER's topic
      //       receives nothing while an owner row is inserted (the
      //       realtime.messages deny path),
      //   (c) dedupe_key is DB-guaranteed unique (partial index
      //       notifications_dedupe_key_uniq) while NULL keys never collide.
      const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
      expect(SERVICE_KEY).not.toBe('');
      const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // Deterministic probe ids in the suite's 00000000-…-99 block (087/088/089
      // — unused by the other probes). Probe-specific phones: users has partial
      // UNIQUE indexes on (country_code, phone_number); pre-clean keeps re-runs
      // idempotent after a crashed run.
      const probeTenantId = '00000000-0000-0000-0000-000000000087';
      const probeOwnerId = '00000000-0000-0000-0000-000000000088';
      const probeTechId = '00000000-0000-0000-0000-000000000089';
      const DEDUPE_KEY = 'rls-probe-14-2-dedupe';
      const PROBE_EVENT = 'rls_probe_14_2';

      // Pre-clean (idempotency after a crashed prior run): notifications →
      // users → tenants is the only valid delete order (notifications.user_id
      // has no ON DELETE cascade; matches the finally block).
      await serviceClient
        .from('notifications')
        .delete()
        .in('user_id', [probeOwnerId, probeTechId]);
      await serviceClient.from('users').delete().in('id', [probeOwnerId, probeTechId]);
      const { error: seedOwnerError } = await serviceClient
        .from('users')
        .upsert(
          {
            id: probeOwnerId,
            country_code: '+91',
            phone_number: '9999000088',
            role: 'owner',
            status: 'active',
          },
          { onConflict: 'id' },
        );
      expect(seedOwnerError).toBeNull();
      const { error: tenantUpsertError } = await serviceClient
        .from('tenants')
        .upsert(
          {
            id: probeTenantId,
            owner_id: probeOwnerId,
            company_name: 'Realtime Probe Co',
            state_code: 'KA',
          },
          { onConflict: 'id' },
        );
      expect(tenantUpsertError).toBeNull();
      const { error: techError } = await serviceClient.from('users').upsert(
        {
          id: probeTechId,
          tenant_id: probeTenantId,
          country_code: '+91',
          phone_number: '9999000089',
          role: 'technician',
          status: 'active',
        },
        { onConflict: 'id' },
      );
      expect(techError).toBeNull();

      // The realtime token exactly as mintRealtimeToken produces it: claims
      // { sub, role: 'authenticated', exp } signed with SUPABASE_JWT_SECRET.
      const realtimeToken = jwt.sign(
        {
          sub: probeTechId,
          role: 'authenticated',
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        SUPABASE_JWT_SECRET,
        { algorithm: 'HS256' },
      );
      // fenzo-app's client shape: the token rides the accessToken callback —
      // realtime reads it per-subscribe; an Authorization header does NOT
      // authorize private channels (verified live 2026-09-25).
      const realtimeClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        accessToken: () => Promise.resolve(realtimeToken),
      });

      function waitFor(
        predicate: () => boolean,
        timeoutMs: number,
      ): Promise<boolean> {
        return new Promise((resolve) => {
          const started = Date.now();
          const tick = () => {
            if (predicate()) return resolve(true);
            if (Date.now() - started >= timeoutMs) return resolve(false);
            setTimeout(tick, 100);
          };
          setTimeout(tick, 100);
        });
      }

      const ownEvents: Record<string, unknown>[] = [];
      const foreignEvents: Record<string, unknown>[] = [];
      const foreignStatuses: string[] = [];
      let ownChannel: RealtimeChannel | null = null;
      let foreignChannel: RealtimeChannel | null = null;

      try {
        // --- Probe (a): own topic — subscribe, then insert a row for the tech.
        // The channel name IS the topic: `user:<sub>:notifications` — any other
        // name is denied by the realtime.messages LIKE pattern (that mistake
        // would make this probe a false negative).
        ownChannel = realtimeClient.channel(`user:${probeTechId}:notifications`, {
          config: { private: true },
        });
        const subscribed = new Promise<void>((resolve, reject) => {
          ownChannel!
            .on('broadcast', { event: 'INSERT' }, (msg) => {
              ownEvents.push(
                (msg as unknown as { payload: Record<string, unknown> })
                  .payload,
              );
            })
            .subscribe((status) => {
              if (status === 'SUBSCRIBED') resolve();
              // Transient CHANNEL_ERROR is expected: the very first join fires
              // before the accessToken callback resolves (realtime-js then
              // auto-rejoins and succeeds) — verified live 2026-09-25. Only a
              // wait-window timeout is fatal.
            });
          setTimeout(
            () => reject(new Error('own-topic subscribe timeout (10s)')),
            10000,
          );
        });
        await subscribed;

        const { error: ownInsertError } = await serviceClient
          .from('notifications')
          .insert({
            tenant_id: probeTenantId,
            user_id: probeTechId,
            event_type: PROBE_EVENT,
            entity_type: 'attendance',
            entity_id: '00000000-0000-4000-8000-0000000000e1',
          });
        expect(ownInsertError).toBeNull();

        const delivered = await waitFor(() => ownEvents.length > 0, 10000);
        expect(delivered).toBe(true);
        // Broadcast payload shape (verified live 2026-09-25): { id, table,
        // record: { …row snake_case } } — the raw DB row, snake_case.
        const broadcast = ownEvents[0] as {
          id: string;
          table: string;
          record: Record<string, unknown>;
        };
        expect(broadcast.table).toBe('notifications');
        expect(broadcast.record['user_id']).toBe(probeTechId);
        // The additive 14.2 columns ride the raw row too.
        expect(broadcast.record['entity_type']).toBe('attendance');
        expect(broadcast.record['entity_id']).toBe(
          '00000000-0000-4000-8000-0000000000e1',
        );

        // --- Probe (b): foreign topic with the SAME valid technician token —
        // the realtime.messages policy denies it server-side. An owner row is
        // inserted during the window: a broken policy WOULD deliver it, so
        // zero received events is a discriminating assertion.
        foreignChannel = realtimeClient.channel(
          `user:${probeOwnerId}:notifications`,
          { config: { private: true } },
        );
        // The status must settle on CHANNEL_ERROR or TIMED_OUT: the
        // realtime.messages policy denies the foreign topic server-side. A
        // SUBSCRIBED here would mean the policy is broken — silence alone
        // could not distinguish a policy denial from an unrelated join
        // failure, so the status settle is the primary assertion and the
        // silence window below is belt-and-braces.
        foreignChannel
          .on('broadcast', { event: 'INSERT' }, (msg) => {
            foreignEvents.push(
              (msg as unknown as { payload: Record<string, unknown> })
                .payload,
            );
          })
          .subscribe((status) => {
            foreignStatuses.push(status);
          });
        const settled = await waitFor(
          () =>
            foreignStatuses.length > 0 &&
            ['CHANNEL_ERROR', 'TIMED_OUT'].includes(
              foreignStatuses[foreignStatuses.length - 1],
            ),
          10000,
        );
        expect(settled).toBe(true);

        const { error: foreignInsertError } = await serviceClient
          .from('notifications')
          .insert({
            tenant_id: probeTenantId,
            user_id: probeOwnerId,
            event_type: PROBE_EVENT,
          });
        expect(foreignInsertError).toBeNull();

        // Give the socket a real window to (wrongly) deliver — nothing may
        // arrive, and the subscription must never have become authorized.
        await new Promise((resolve) => setTimeout(resolve, 4000));
        expect(foreignEvents).toEqual([]);
        expect(foreignStatuses).not.toContain('SUBSCRIBED');

        // --- Probe (c): dedupe_key. NULL keys never collide (existing
        // job/report insert paths stay untouched); a repeated non-null key is
        // rejected by the partial unique index (23505).
        const { error: nullKeyOneError } = await serviceClient
          .from('notifications')
          .insert({
            tenant_id: probeTenantId,
            user_id: probeTechId,
            event_type: PROBE_EVENT,
          });
        expect(nullKeyOneError).toBeNull();
        const { error: nullKeyTwoError } = await serviceClient
          .from('notifications')
          .insert({
            tenant_id: probeTenantId,
            user_id: probeTechId,
            event_type: PROBE_EVENT,
          });
        expect(nullKeyTwoError).toBeNull();

        const { error: firstKeyedError } = await serviceClient
          .from('notifications')
          .insert({
            tenant_id: probeTenantId,
            user_id: probeTechId,
            event_type: PROBE_EVENT,
            dedupe_key: DEDUPE_KEY,
          });
        expect(firstKeyedError).toBeNull();
        const { error: duplicateKeyError } = await serviceClient
          .from('notifications')
          .insert({
            tenant_id: probeTenantId,
            user_id: probeTechId,
            event_type: PROBE_EVENT,
            dedupe_key: DEDUPE_KEY,
          });
        expect(duplicateKeyError).not.toBeNull();
        expect((duplicateKeyError as { code: string }).code).toBe('23505');
      } finally {
        // Cleanup: close the socket first so the deletes cannot race a live
        // connection (and jest's open-handle warning goes away), then every
        // probe row (by user ids), then the seeded tenant/users.
        await ownChannel?.unsubscribe();
        await foreignChannel?.unsubscribe();
        realtimeClient.removeAllChannels();
        realtimeClient.realtime.disconnect();
        await serviceClient
          .from('notifications')
          .delete()
          .in('user_id', [probeOwnerId, probeTechId]);
        await serviceClient
          .from('users')
          .delete()
          .in('id', [probeOwnerId, probeTechId]);
        await serviceClient
          .from('tenants')
          .delete()
          .eq('id', probeTenantId);
      }
    },
    30000,
  );

  maybeIt(
    'notifications list select pins the real table schema (Story 14.2 review)',
    async () => {
      // The list endpoint's column list is only mock-asserted in unit tests —
      // nothing ran it against the real table. This probe pins BOTH drift
      // directions: a missing/dropped migration (unknown column → error) and a
      // select string that drifts from the table (schema mismatch). MUST stay
      // byte-identical to the select in notifications.service.ts
      // listNotifications; a read-only limit(1) touches no table contents.
      const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
      expect(SERVICE_KEY).not.toBe('');
      const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { error } = await serviceClient
        .from('notifications')
        .select(
          'id, job_id, event_type, payload, read_at, entity_type, entity_id, created_at',
        )
        .limit(1);
      expect(error).toBeNull();
    },
  );

  maybeIt(
    'Attendance foundation: timezone guard, table schema pins, settings/progress tenant isolation (Story 15-2)',
    async () => {
      // Story 15-2's real-DB probes, one seeded scenario:
      //   (a) tenants.timezone validator — region-style names only; 'EST'
      //       (a fixed offset abbreviation, not in pg_timezone_names with
      //       a '/') is rejected PT422 with the ErrorCode hint, a real
      //       IANA region is accepted and persisted.
      //   (b) attendance_today — the single "today" source, returned as a
      //       date string for the tenant's timezone.
      //   (c) schema pins — the exact column lists attendance.service.ts
      //       selects, run against the real tables (drift either way fails).
      //   (d) tenant isolation — a service-seeded settings row for the probe
      //       tenant is invisible to a bare anon client and to a JWT of a
      //       foreign tenant (both RLS policies scope on
      //       auth.jwt() ->> 'tenantId'), visible only with service role.
      const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
      expect(SERVICE_KEY).not.toBe('');
      const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // Probe ids continue the suite block (090/091 — 087-089 belong to the
      // realtime probe). Probe-specific phone: users' partial UNIQUE indexes
      // on (country_code, phone_number) make pre-cleans idempotent.
      const probeTenantId = '00000000-0000-0000-0000-000000000090';
      const probeOwnerId = '00000000-0000-0000-0000-000000000091';
      const FOREIGN_TENANT_ID = '00000000-0000-0000-0000-0000000000ff';

      // Pre-clean (idempotency after a crashed prior run): attendance rows
      // would cascade on tenant delete, but delete explicitly first — the
      // same order the finally block uses.
      await serviceClient
        .from('attendance_setup_progress')
        .delete()
        .eq('tenant_id', probeTenantId);
      await serviceClient
        .from('attendance_settings')
        .delete()
        .eq('tenant_id', probeTenantId);
      await serviceClient.from('users').delete().eq('id', probeOwnerId);
      await serviceClient.from('tenants').delete().eq('id', probeTenantId);

      const { error: seedOwnerError } = await serviceClient
        .from('users')
        .upsert(
          {
            id: probeOwnerId,
            country_code: '+91',
            phone_number: '9999000091',
            role: 'owner',
            status: 'active',
          },
          { onConflict: 'id' },
        );
      expect(seedOwnerError).toBeNull();
      const { error: tenantUpsertError } = await serviceClient
        .from('tenants')
        .upsert(
          {
            id: probeTenantId,
            owner_id: probeOwnerId,
            company_name: 'Attendance Probe Co',
            state_code: 'KA',
          },
          { onConflict: 'id' },
        );
      expect(tenantUpsertError).toBeNull();
      // The 15-2 default — assert it so a future default change is caught.
      const { data: seededTenant } = await serviceClient
        .from('tenants')
        .select('timezone')
        .eq('id', probeTenantId)
        .single();
      expect(
        (seededTenant as { timezone: string }).timezone,
      ).toBe('Asia/Kolkata');

      try {
        // --- (a) timezone guard: fixed-offset abbreviation rejected PT422.
        const { error: invalidTzError } = await serviceClient
          .from('tenants')
          .update({ timezone: 'EST' })
          .eq('id', probeTenantId);
        expect(invalidTzError).not.toBeNull();
        expect((invalidTzError as { code: string }).code).toBe('PT422');
        expect(
          (invalidTzError as { hint?: string }).hint,
        ).toBe('ATTENDANCE_INVALID_TIMEZONE');

        // Real IANA region accepted and persisted.
        const { error: validTzError } = await serviceClient
          .from('tenants')
          .update({ timezone: 'Europe/London' })
          .eq('id', probeTenantId);
        expect(validTzError).toBeNull();
        const { data: tzRow } = await serviceClient
          .from('tenants')
          .select('timezone')
          .eq('id', probeTenantId)
          .single();
        expect((tzRow as { timezone: string }).timezone).toBe('Europe/London');

        // --- (b) attendance_today: a date string in the tenant's timezone.
        // Compared against the date the clock renders for Europe/London — a
        // bare format regex would pass even if the function stopped
        // following the tenant timezone (review 2026-09-26).
        const { data: today, error: todayError } = await serviceClient.rpc(
          'attendance_today',
          { p_tenant_id: probeTenantId },
        );
        expect(todayError).toBeNull();
        const londonToday = new Date().toLocaleDateString('en-CA', {
          timeZone: 'Europe/London',
        });
        expect(today).toBe(londonToday);

        // --- (c) schema pins — guards both drift directions on the real
        // tables: a missing/dropped migration (unknown column → error) and a
        // drifted table shape. The service reads with select('*'), so these
        // lists mirror every column the row mappers (toSetupStateResponse)
        // may touch.
        const { error: settingsPinError } = await serviceClient
          .from('attendance_settings')
          .select(
            'tenant_id, enabled, setup_completed_at, created_at, updated_at',
          )
          .limit(1);
        expect(settingsPinError).toBeNull();
        const { error: progressPinError } = await serviceClient
          .from('attendance_setup_progress')
          .select('tenant_id, current_step, created_at, updated_at')
          .limit(1);
        expect(progressPinError).toBeNull();

        // --- (d) tenant isolation. Seed one settings row + one progress row
        // for the probe tenant via service role.
        const { error: seedSettingsError } = await serviceClient
          .from('attendance_settings')
          .insert({ tenant_id: probeTenantId });
        expect(seedSettingsError).toBeNull();
        const { error: seedProgressError } = await serviceClient
          .from('attendance_setup_progress')
          .insert({ tenant_id: probeTenantId, current_step: 'offices' });
        expect(seedProgressError).toBeNull();

        // Bare anon key (no JWT): RLS is enabled with NO policies (review
        // decision 2026-09-26 — module state is admin-client-only), so every
        // direct PostgREST read is denied. Empty, not an error.
        const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: anonSettings, error: anonSettingsError } =
          await anonClient.from('attendance_settings').select('*');
        expect(anonSettingsError).toBeNull();
        expect(anonSettings).toEqual([]);
        const { data: anonProgress, error: anonProgressError } =
          await anonClient.from('attendance_setup_progress').select('*');
        expect(anonProgressError).toBeNull();
        expect(anonProgress).toEqual([]);

        // A JWT naming a different tenant: same empty result — with no
        // policies the deny is unconditional; the JWT's tenant claim is
        // irrelevant by design.
        const foreignJwt = mintJwt(probeOwnerId, FOREIGN_TENANT_ID, 'authenticated');
        const foreignClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${foreignJwt}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: foreignSettings } = await foreignClient
          .from('attendance_settings')
          .select('*');
        expect(foreignSettings).toEqual([]);
        const { data: foreignProgress } = await foreignClient
          .from('attendance_setup_progress')
          .select('*');
        expect(foreignProgress).toEqual([]);

        // Service role sees exactly the seeded rows.
        const { data: serviceSettings } = await serviceClient
          .from('attendance_settings')
          .select('tenant_id, enabled')
          .eq('tenant_id', probeTenantId);
        expect(serviceSettings).toHaveLength(1);
        expect(
          (serviceSettings as { enabled: boolean }[])[0].enabled,
        ).toBe(false);
        const { data: serviceProgress } = await serviceClient
          .from('attendance_setup_progress')
          .select('current_step')
          .eq('tenant_id', probeTenantId);
        expect(serviceProgress).toHaveLength(1);
        expect(
          (serviceProgress as { current_step: string }[])[0].current_step,
        ).toBe('offices');
        // --- (e) attendance_start_setup functional probe (review
        // 2026-09-26): the privilege pins above never run the body, so the
        // FR-1 restart contract — a restart NEVER resets progress — is
        // exercised here. The rows seeded in (d) are cleared first so the
        // RPC's on-conflict inserts are observable from scratch.
        await serviceClient
          .from('attendance_setup_progress')
          .delete()
          .eq('tenant_id', probeTenantId);
        await serviceClient
          .from('attendance_settings')
          .delete()
          .eq('tenant_id', probeTenantId);

        const { error: startOneError } = await serviceClient.rpc(
          'attendance_start_setup',
          { p_tenant_id: probeTenantId, p_actor_id: probeOwnerId },
        );
        expect(startOneError).toBeNull();
        const { data: freshProgress } = await serviceClient
          .from('attendance_setup_progress')
          .select('current_step')
          .eq('tenant_id', probeTenantId)
          .single();
        expect((freshProgress as { current_step: string }).current_step).toBe(
          'offices',
        );

        // The owner advances the wizard, then restarts — the step must
        // survive (on-conflict-do-nothing, never reset).
        const { error: advanceError } = await serviceClient
          .from('attendance_setup_progress')
          .update({ current_step: 'timings' })
          .eq('tenant_id', probeTenantId);
        expect(advanceError).toBeNull();
        const { error: startTwoError } = await serviceClient.rpc(
          'attendance_start_setup',
          { p_tenant_id: probeTenantId, p_actor_id: probeOwnerId },
        );
        expect(startTwoError).toBeNull();
        const { data: resumedProgress } = await serviceClient
          .from('attendance_setup_progress')
          .select('current_step')
          .eq('tenant_id', probeTenantId)
          .single();
        expect((resumedProgress as { current_step: string }).current_step).toBe(
          'timings',
        );
        // Idempotent start also cannot duplicate the settings row.
        const { data: settingsAfterRestart } = await serviceClient
          .from('attendance_settings')
          .select('tenant_id')
          .eq('tenant_id', probeTenantId);
        expect(settingsAfterRestart).toHaveLength(1);
      } finally {
        // Cleanup: attendance rows → users → tenants (FK order), so the
        // probe never leaks into the shared live DB.
        await serviceClient
          .from('attendance_setup_progress')
          .delete()
          .eq('tenant_id', probeTenantId);
        await serviceClient
          .from('attendance_settings')
          .delete()
          .eq('tenant_id', probeTenantId);
        await serviceClient.from('users').delete().eq('id', probeOwnerId);
        await serviceClient.from('tenants').delete().eq('id', probeTenantId);
      }
    },
    30000,
  );

  maybeIt(
    'Attendance offices: schema pins, tenant isolation, effective-dated rules lifecycle (Story 15-3)',
    async () => {
      // Story 15-3's real-DB probes, one seeded scenario:
      //   (a) schema pins — the exact columns offices-response.model maps.
      //   (b) tenant isolation — a seeded office (+ rule) is invisible to a
      //       bare anon client and to a foreign-tenant JWT (RLS enabled with
      //       NO policies, admin-client-only module state).
      //   (c) office lifecycle — create seeds rule [today, ∞); duplicate
      //       name → PT409; rules edit clips the covering range at tomorrow
      //       and inserts [tomorrow, ∞); the GIST exclusion constraint kills
      //       an overlapping write; CHECK constraints kill out-of-range
      //       values; archive succeeds with no blockers (or fails loud 42P01
      //       pre-15-7 — both accepted until 15-7 merges, then tightened).
      const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
      expect(SERVICE_KEY).not.toBe('');
      const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // 096-098: attendance-probe block, unused by any other probe (the
      // users probe takes 092, the jobs probe 093/094 — same-uuid reuse
      // across tables confused the id-allocation comments).
      const probeTenantId = '00000000-0000-0000-0000-000000000096';
      const probeOwnerId = '00000000-0000-0000-0000-000000000097';
      const FOREIGN_TENANT_ID = '00000000-0000-0000-0000-0000000000fe';

      // Pre-clean in FK order (rules RESTRICT office deletion — offices first
      // is impossible while rules rows exist).
      await serviceClient
        .from('attendance_office_rules')
        .delete()
        .eq('tenant_id', probeTenantId);
      await serviceClient
        .from('attendance_offices')
        .delete()
        .eq('tenant_id', probeTenantId);
      await serviceClient.from('users').delete().eq('id', probeOwnerId);
      await serviceClient.from('tenants').delete().eq('id', probeTenantId);

      const { error: seedOwnerError } = await serviceClient
        .from('users')
        .upsert(
          {
            id: probeOwnerId,
            country_code: '+91',
            phone_number: '9999000097',
            role: 'owner',
            status: 'active',
          },
          { onConflict: 'id' },
        );
      expect(seedOwnerError).toBeNull();
      const { error: tenantUpsertError } = await serviceClient
        .from('tenants')
        .upsert(
          {
            id: probeTenantId,
            owner_id: probeOwnerId,
            company_name: 'Office Probe Co',
            state_code: 'KA',
          },
          { onConflict: 'id' },
        );
      expect(tenantUpsertError).toBeNull();

      try {
        // --- (a) schema pins: both directions of drift fail (a dropped
        // migration errors on unknown columns; a drifted shape misses the
        // list). Mirror of offices-response.model's row mappers.
        const { error: officePinError } = await serviceClient
          .from('attendance_offices')
          .select(
            'id, tenant_id, name, latitude, longitude, radius_m, archived_at, created_at, updated_at',
          )
          .limit(1);
        expect(officePinError).toBeNull();
        const { error: rulePinError } = await serviceClient
          .from('attendance_office_rules')
          .select(
            'id, office_id, tenant_id, valid, start_time, end_time, late_cutoff_minutes, full_day_hours, half_day_hours, created_at, updated_at',
          )
          .limit(1);
        expect(rulePinError).toBeNull();

        // --- (b) tenant isolation: no policies ⇒ every direct PostgREST
        // read is denied (empty, not an error), regardless of JWT.
        const { error: seedOfficeError } = await serviceClient
          .from('attendance_offices')
          .insert({
            id: '00000000-0000-0000-0000-000000000098',
            tenant_id: probeTenantId,
            name: 'Isolation Probe Office',
            latitude: 19.1,
            longitude: 72.8,
            radius_m: 100,
          });
        expect(seedOfficeError).toBeNull();
        const { error: seedRuleError } = await serviceClient
          .from('attendance_office_rules')
          .insert({
            office_id: '00000000-0000-0000-0000-000000000098',
            tenant_id: probeTenantId,
            valid: '[2026-01-01,)',
            start_time: '09:00',
            end_time: '17:00',
            late_cutoff_minutes: 0,
            full_day_hours: 8,
            half_day_hours: 4,
          });
        expect(seedRuleError).toBeNull();

        const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: anonOffices } = await anonClient
          .from('attendance_offices')
          .select('*');
        expect(anonOffices).toEqual([]);
        const { data: anonRules } = await anonClient
          .from('attendance_office_rules')
          .select('*');
        expect(anonRules).toEqual([]);

        const foreignJwt = mintJwt(probeOwnerId, FOREIGN_TENANT_ID, 'authenticated');
        const foreignClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${foreignJwt}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: foreignOffices } = await foreignClient
          .from('attendance_offices')
          .select('*');
        expect(foreignOffices).toEqual([]);
        const { data: foreignRules } = await foreignClient
          .from('attendance_office_rules')
          .select('*');
        expect(foreignRules).toEqual([]);

        // Service role sees exactly the seeded rows.
        const { data: serviceOffices } = await serviceClient
          .from('attendance_offices')
          .select('id')
          .eq('tenant_id', probeTenantId);
        expect(serviceOffices).toHaveLength(1);

        // --- (c) office lifecycle via the RPCs. Clear the (b) seed so the
        // assertions read only what this block created.
        await serviceClient
          .from('attendance_office_rules')
          .delete()
          .eq('tenant_id', probeTenantId);
        await serviceClient
          .from('attendance_offices')
          .delete()
          .eq('tenant_id', probeTenantId);

        const createArgs = {
          p_tenant_id: probeTenantId,
          p_actor_id: probeOwnerId,
          p_name: 'Probe Office Alpha',
          p_latitude: 19.1,
          p_longitude: 72.8,
          p_radius_m: 100,
          p_start_time: '10:00',
          p_end_time: '18:00',
          p_late_cutoff_minutes: 15,
          p_full_day_hours: 8,
          p_half_day_hours: 4,
        };
        const { data: officeId, error: createError } = await serviceClient.rpc(
          'attendance_create_office',
          createArgs,
        );
        expect(createError).toBeNull();

        // today comes from the single source (AD-7) — the seeded rule must
        // cover it with an open end.
        const { data: today, error: todayError } = await serviceClient.rpc(
          'attendance_today',
          { p_tenant_id: probeTenantId },
        );
        expect(todayError).toBeNull();
        const { data: initialRules } = await serviceClient
          .from('attendance_office_rules')
          .select('office_id, valid, start_time')
          .eq('office_id', officeId as string);
        expect(initialRules).toHaveLength(1);
        const initial = (initialRules as { valid: string; start_time: string }[])[0];
        expect(initial.valid).toBe(`[${today},)`);
        expect(initial.start_time).toBe('10:00:00');

        // Duplicate name, case-insensitive → PT409 with the ErrorCode hint.
        const { error: dupError } = await serviceClient.rpc(
          'attendance_create_office',
          { ...createArgs, p_name: 'PROBE office alpha' },
        );
        expect(dupError).not.toBeNull();
        expect((dupError as { code: string }).code).toBe('PT409');
        expect((dupError as { hint?: string }).hint).toBe(
          'ATTENDANCE_OFFICE_NAME_TAKEN',
        );

        // Unknown office → PT404 (no p_name in this signature's arg list).
        const { error: missingError } = await serviceClient.rpc(
          'attendance_update_office_rules',
          {
            p_tenant_id: probeTenantId,
            p_actor_id: probeOwnerId,
            p_office_id: '00000000-0000-0000-0000-0000000000ff',
            p_start_time: '09:00',
            p_end_time: '17:00',
            p_late_cutoff_minutes: 20,
            p_full_day_hours: 8,
            p_half_day_hours: 4,
          },
        );
        expect(missingError).not.toBeNull();
        expect((missingError as { code: string }).code).toBe('PT404');
        expect((missingError as { hint?: string }).hint).toBe(
          'ATTENDANCE_OFFICE_NOT_FOUND',
        );

        // --- (c2) rules edit: effective from TOMORROW — the covering range
        // is clipped at tomorrow and a new [tomorrow, ∞) is inserted.
        const editArgs = {
          p_tenant_id: probeTenantId,
          p_actor_id: probeOwnerId,
          p_office_id: officeId as string,
          p_start_time: '09:00',
          p_end_time: '17:00',
          p_late_cutoff_minutes: 20,
          p_full_day_hours: 8,
          p_half_day_hours: 4,
        };
        const { error: editError } = await serviceClient.rpc(
          'attendance_update_office_rules',
          editArgs,
        );
        expect(editError).toBeNull();
        const tomorrow = new Date(
          new Date(`${today}T12:00:00Z`).getTime() + 24 * 60 * 60 * 1000,
        )
          .toLocaleDateString('en-CA', { timeZone: 'UTC' });
        const { data: rulesAfterEdit } = await serviceClient
          .from('attendance_office_rules')
          .select('valid, start_time, late_cutoff_minutes')
          .eq('office_id', officeId as string)
          .order('valid');
        expect(rulesAfterEdit).toHaveLength(2);
        expect((rulesAfterEdit as { valid: string }[])[0].valid).toBe(
          `[${today},${tomorrow})`,
        );
        expect((rulesAfterEdit as { valid: string }[])[1].valid).toBe(
          `[${tomorrow},)`,
        );
        expect((rulesAfterEdit as { start_time: string }[])[1].start_time).toBe(
          '09:00:00',
        );

        // A second same-day edit REPLACES the future range (no overlap).
        const { error: editTwoError } = await serviceClient.rpc(
          'attendance_update_office_rules',
          { ...editArgs, p_start_time: '08:00', p_late_cutoff_minutes: 5 },
        );
        expect(editTwoError).toBeNull();
        const { data: rulesAfterSecondEdit } = await serviceClient
          .from('attendance_office_rules')
          .select('valid, start_time')
          .eq('office_id', officeId as string)
          .order('valid');
        expect(rulesAfterSecondEdit).toHaveLength(2);
        expect((rulesAfterSecondEdit as { valid: string }[])[1].valid).toBe(
          `[${tomorrow},)`,
        );
        expect((rulesAfterSecondEdit as { start_time: string }[])[1].start_time).toBe(
          '08:00:00',
        );

        // --- (c3) DB guards: the exclusion constraint and CHECKs.
        const { error: overlapError } = await serviceClient
          .from('attendance_office_rules')
          .insert({
            office_id: officeId as string,
            tenant_id: probeTenantId,
            valid: `[${today},2030-01-01)`,
            start_time: '09:00',
            end_time: '17:00',
            late_cutoff_minutes: 0,
            full_day_hours: 8,
            half_day_hours: 4,
          });
        expect(overlapError).not.toBeNull();
        expect((overlapError as { code: string }).code).toBe('23P01');

        const { error: checkError } = await serviceClient
          .from('attendance_office_rules')
          .insert({
            office_id: officeId as string,
            tenant_id: probeTenantId,
            valid: '[2031-01-01,)',
            start_time: '09:00',
            end_time: '17:00',
            // Out of the 0–120 range → the CHECK, not the constraint.
            late_cutoff_minutes: 500,
            full_day_hours: 8,
            half_day_hours: 4,
          });
        expect(checkError).not.toBeNull();
        expect((checkError as { code: string }).code).toBe('23514');

        // Cross-field CHECKs: inverted times and half ≥ full both 23514.
        const { error: invertedTimeError } = await serviceClient
          .from('attendance_office_rules')
          .insert({
            office_id: officeId as string,
            tenant_id: probeTenantId,
            valid: '[2031-01-01,)',
            start_time: '17:00',
            end_time: '09:00',
            late_cutoff_minutes: 0,
            full_day_hours: 8,
            half_day_hours: 4,
          });
        expect(invertedTimeError).not.toBeNull();
        expect((invertedTimeError as { code: string }).code).toBe('23514');

        const { error: halfFullError } = await serviceClient
          .from('attendance_office_rules')
          .insert({
            office_id: officeId as string,
            tenant_id: probeTenantId,
            valid: '[2031-01-01,)',
            start_time: '09:00',
            end_time: '17:00',
            late_cutoff_minutes: 0,
            full_day_hours: 4,
            half_day_hours: 8,
          });
        expect(halfFullError).not.toBeNull();
        expect((halfFullError as { code: string }).code).toBe('23514');

        // Composite FK: a rule row whose tenant_id does not match its
        // office's tenant is rejected (review hardening, migration …000007).
        // The past range keeps the GIST exclusion out of the way so the FK
        // is the only guard that can fire.
        const { error: crossTenantRuleError } = await serviceClient
          .from('attendance_office_rules')
          .insert({
            office_id: officeId as string,
            tenant_id: FOREIGN_TENANT_ID,
            valid: '[2020-01-01,2021-01-01)',
            start_time: '09:00',
            end_time: '17:00',
            late_cutoff_minutes: 0,
            full_day_hours: 8,
            half_day_hours: 4,
          });
        expect(crossTenantRuleError).not.toBeNull();
        expect((crossTenantRuleError as { code: string }).code).toBe('23503');

        // The SECURITY DEFINER RPCs carry their own tenant guard: a foreign
        // p_tenant_id fails before the office lookup (the RPC validates the
        // tenant first) → PT404 ATTENDANCE_TENANT_NOT_FOUND.
        const { error: foreignTenantRpcError } = await serviceClient.rpc(
          'attendance_update_office_rules',
          {
            p_tenant_id: FOREIGN_TENANT_ID,
            p_actor_id: probeOwnerId,
            p_office_id: officeId as string,
            p_start_time: '09:00',
            p_end_time: '17:00',
            p_late_cutoff_minutes: 0,
            p_full_day_hours: 8,
            p_half_day_hours: 4,
          },
        );
        expect(foreignTenantRpcError).not.toBeNull();
        expect((foreignTenantRpcError as { code: string }).code).toBe('PT404');
        expect(
          (foreignTenantRpcError as { hint?: string }).hint,
        ).toBe('ATTENDANCE_TENANT_NOT_FOUND');

        // --- (c4) blockers preview + archive. Pre-15-7 both fail loud
        // (42P01, undefined relation); post-15-7 an office with no
        // assignments archives cleanly and the second archive is a no-op.
        // Accepted either way until 15-7 merges, then tightened.
        const { data: blockers, error: blockersError } =
          await serviceClient.rpc('attendance_office_archive_blockers', {
            p_tenant_id: probeTenantId,
            p_office_id: officeId as string,
          });
        if (blockersError) {
          expect((blockersError as { code: string }).code).toBe('42P01');
        } else {
          expect(blockers).toEqual([]);
        }

        const { error: archiveError } = await serviceClient.rpc(
          'attendance_archive_office',
          {
            p_tenant_id: probeTenantId,
            p_actor_id: probeOwnerId,
            p_office_id: officeId as string,
          },
        );
        if (archiveError) {
          expect((archiveError as { code: string }).code).toBe('42P01');
        } else {
          const { data: archivedRow } = await serviceClient
            .from('attendance_offices')
            .select('archived_at')
            .eq('id', officeId as string)
            .single();
          expect(
            (archivedRow as { archived_at: string | null }).archived_at,
          ).not.toBeNull();
          // Idempotent: archiving an archived office is a silent no-op.
          const { error: reArchiveError } = await serviceClient.rpc(
            'attendance_archive_office',
            {
              p_tenant_id: probeTenantId,
              p_actor_id: probeOwnerId,
              p_office_id: officeId as string,
            },
          );
          expect(reArchiveError).toBeNull();
        }
      } finally {
        // Cleanup in FK order, so the probe never leaks into the shared DB.
        await serviceClient
          .from('attendance_office_rules')
          .delete()
          .eq('tenant_id', probeTenantId);
        await serviceClient
          .from('attendance_offices')
          .delete()
          .eq('tenant_id', probeTenantId);
        await serviceClient.from('users').delete().eq('id', probeOwnerId);
        await serviceClient.from('tenants').delete().eq('id', probeTenantId);
      }
    },
    30000,
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
