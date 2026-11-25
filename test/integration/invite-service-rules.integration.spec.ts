/**
 * The invite RULES on the real shipped path — AuthService.inviteMember over a
 * real DEV database (the service the 2026-11-25 EMP-code collision fix moved
 * minting into). This carries the real-DB coverage the dropped invite_member
 * RPC suites (member-functions-invite / -rules) used to hold: refusals, name
 * semantics, skills all-or-nothing, the caller matrix, platform-admin invites
 * and the same-phone races that prove the phone advisory lock serializes
 * cross-company invites into typed 409s instead of raw unique violations.
 *
 * Format-only validation (malformed country codes/phones, unknown roles) is
 * a DTO contract the service never sees in production; it is pinned at the
 * HTTP boundary by the malformed-phone, invalid-role and 6-digit-boundary
 * cases in test/invite.e2e-spec.ts (moved there from these suites on the
 * 2026-11-25 drop — the deleted RPC suites were their only other home).
 */
import { randomUUID } from 'crypto';
import {
  call,
  auditFor,
  membershipIn,
  membershipsOf,
  mid,
  randomPhone,
  seedPlatformAdmin,
  setUserFlag,
} from '../helpers/member-functions-fixture';
import {
  ALREADY_IN_TEAM,
  DUPLICATE,
  FORBIDDEN,
  NOT_FOUND,
  PLATFORM_STAFF,
  VALIDATION,
  P,
  PHONE,
  useInviteServiceWorld,
} from '../helpers/invite-service-world';

/** The service path runs ~a dozen statements per invite over the pool; the
 *  RPC it replaced answered in one round trip, so every test carries an
 *  explicit timeout. */
const RULES_TIMEOUT = 30000;

describe('AuthService.inviteMember rules (real DB — the shipped invite path)', () => {
  const {
    maybeIt,
    service,
    invite,
    ok,
    refusal,
    usersWithPhone,
    inviteAuditCount,
    skillId: getSkillId,
  } = useInviteServiceWorld();
  const skillIdValue = () => getSkillId();

  maybeIt(
    'happy path: creates the person, an invited membership with an EMP- code, the skills and one audit row carrying the minted code',
    async () => {
      const phone = randomPhone();
      const row = ok(
        await invite(P.adminA, P.tenantA, phone, {
          name: '  MF Happy  ',
          role: 'employee',
          skills: [skillIdValue()],
        }),
      );
      expect(row.invite_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.employee_code).toMatch(/^EMP-\d{3,}$/);
      expect(row.sms_status).toBe('not_configured'); // stubbed in the world

      const users = await usersWithPhone(phone);
      expect(users).toEqual([
        { id: row.invite_id, name: 'MF Happy', country_code: '+91' },
      ]); // name is trimmed
      const m = await membershipIn(service, row.invite_id, P.tenantA);
      expect(m).toMatchObject({
        role: 'employee',
        status: 'invited',
        employee_code: row.employee_code,
        invited_by: P.adminA,
      });
      const { data: skills } = await service
        .from('user_skills')
        .select('skill_id')
        .eq('user_id', row.invite_id);
      expect(skills).toEqual([{ skill_id: skillIdValue() }]);

      const audit = await auditFor(service, row.invite_id);
      expect(audit).toEqual([
        {
          actor_user_id: P.adminA,
          actor_is_platform_admin: false,
          tenant_id: P.tenantA,
          action: 'member.invite',
          target_user_id: row.invite_id,
          details: {
            role: 'employee',
            reactivated: false,
            employee_code: row.employee_code,
          },
        },
      ]);
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'each role (company_admin, employee, viewer) can be invited and lands on the membership',
    async () => {
      for (const role of ['company_admin', 'employee', 'viewer']) {
        const phone = randomPhone();
        const row = ok(await invite(P.adminA, P.tenantA, phone, { role }));
        expect(
          (await membershipIn(service, row.invite_id, P.tenantA))?.role,
        ).toBe(role);
      }
      // An invalid role never reaches the service: the DTO refuses it with a
      // 422 at the HTTP boundary — pinned by the invalid-role e2e case in
      // test/invite.e2e-spec.ts.
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'employee codes are sequential and unique when many invites hit one company at once',
    async () => {
      const phones = [1, 2, 3, 4, 5].map(() => randomPhone());
      const results = await Promise.all(
        phones.map((p) => invite(P.adminA, P.tenantA, p)),
      );
      const rows = results.map(ok);
      const codes = rows.map((r) => r.employee_code);
      expect(new Set(codes).size).toBe(5);
      const nums = codes.map((c) => Number(c.slice(4))).sort((a, b) => a - b);
      for (let i = 1; i < nums.length; i++)
        expect(nums[i]).toBe(nums[i - 1] + 1);
    },
    60000,
  );

  maybeIt(
    'a removed member re-invited to the SAME company keeps the person id and employee code (new role, status invited)',
    async () => {
      const phone = randomPhone();
      const first = ok(
        await invite(P.adminA, P.tenantA, phone, { name: 'MF First Name' }),
      );
      const removed = await call(service, 'remove_member', {
        p_caller: P.adminA,
        p_tenant_id: P.tenantA,
        p_member_user_id: first.invite_id,
      });
      expect(removed.error).toBeNull();
      expect(
        (await membershipIn(service, first.invite_id, P.tenantA))?.status,
      ).toBe('removed');

      const again = ok(
        await invite(P.adminA, P.tenantA, phone, {
          role: 'viewer',
          name: 'MF Different Name',
        }),
      );
      expect(again.invite_id).toBe(first.invite_id);
      expect(again.employee_code).toBe(first.employee_code); // code kept

      const rows = await membershipsOf(service, first.invite_id);
      expect(rows).toHaveLength(1); // no second membership row
      expect(rows[0]).toMatchObject({ status: 'invited', role: 'viewer' });
      // An existing name is never overwritten.
      expect((await usersWithPhone(phone))[0].name).toBe('MF First Name');

      const audit = await auditFor(service, first.invite_id, 'member.invite');
      expect(audit.map((a) => a.details)).toEqual(
        expect.arrayContaining([
          {
            role: 'employee',
            reactivated: false,
            employee_code: first.employee_code,
          },
          {
            role: 'viewer',
            reactivated: true,
            employee_code: first.employee_code,
          },
        ]),
      );
      expect(audit).toHaveLength(2);
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'a person removed from company A can be invited by company B: new membership and code in B, the A row stays removed',
    async () => {
      const phone = randomPhone();
      const inA = ok(await invite(P.adminA, P.tenantA, phone));
      await call(service, 'remove_member', {
        p_caller: P.adminA,
        p_tenant_id: P.tenantA,
        p_member_user_id: inA.invite_id,
      });
      const inB = ok(await invite(P.adminB, P.tenantB, phone));
      expect(inB.invite_id).toBe(inA.invite_id);
      expect(inB.employee_code).not.toBe(inA.employee_code);
      const rows = await membershipsOf(service, inA.invite_id);
      expect(rows.map((r) => [r.tenant_id, r.status]).sort()).toEqual(
        [
          [P.tenantA, 'removed'],
          [P.tenantB, 'invited'],
        ].sort(),
      );
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'a person already invited or active anywhere is refused (ALREADY_IN_TEAM in this company, DUPLICATE_RESOURCE in another) and nothing changes',
    async () => {
      const before = await inviteAuditCount(P.tenantA);
      // Active in ANOTHER company (employeeB, seeded phone).
      const r1 = await invite(P.adminA, P.tenantA, PHONE.employeeB);
      expect(refusal(r1)).toEqual(DUPLICATE);
      expect(await membershipIn(service, P.employeeB, P.tenantA)).toBeNull();
      // Active in the SAME company.
      const r2 = await invite(P.adminA, P.tenantA, PHONE.employeeA);
      expect(refusal(r2)).toEqual(ALREADY_IN_TEAM);
      // Already invited (not yet active) in the same company.
      const phone = randomPhone();
      ok(await invite(P.adminA, P.tenantA, phone));
      const r3 = await invite(P.adminA, P.tenantA, phone);
      expect(refusal(r3)).toEqual(ALREADY_IN_TEAM);
      // Invited in another company.
      const r4 = await invite(P.adminB, P.tenantB, phone);
      expect(refusal(r4)).toEqual(DUPLICATE);
      expect(await inviteAuditCount(P.tenantA)).toBe(before + 1); // only the one success
      expect(await auditFor(service, P.employeeB)).toEqual([]);
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'a Fenzit staff number is refused with PLATFORM_STAFF_NOT_MEMBER and no membership is created',
    async () => {
      const staffId = randomUUID();
      const phone = randomPhone();
      await seedPlatformAdmin(service, staffId, phone);
      const r = await invite(P.adminA, P.tenantA, phone);
      expect(refusal(r)).toEqual(PLATFORM_STAFF);
      expect(await membershipIn(service, staffId, P.tenantA)).toBeNull();
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'a well-formed but unsupported dial code (not in country_codes) is refused with VALIDATION_ERROR before anything is created',
    async () => {
      // The old RPC suite had this as a KNOWN FAILING case (a raw 23503 from
      // the users.country_code FK). The service checks country_codes first,
      // so the typed 400 now precedes any database write — pinned here.
      const before = await inviteAuditCount(P.tenantA);
      for (const cc of ['+1264', '+999']) {
        const phone = randomPhone();
        const r = await invite(P.adminA, P.tenantA, phone, { cc });
        expect({ cc, ...refusal(r) }).toEqual({ cc, ...VALIDATION });
        expect(await usersWithPhone(phone)).toEqual([]);
      }
      expect(await inviteAuditCount(P.tenantA)).toBe(before);
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'an unknown skill id is refused and nothing is created (all or nothing)',
    async () => {
      const phone = randomPhone();
      const before = await inviteAuditCount(P.tenantA);
      const r = await invite(P.adminA, P.tenantA, phone, {
        skills: [skillIdValue(), mid('e002', 777)],
      });
      expect(refusal(r)).toEqual(VALIDATION);
      expect(await usersWithPhone(phone)).toEqual([]);
      expect(await inviteAuditCount(P.tenantA)).toBe(before);
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'a disabled invitee is refused with FORBIDDEN, a platform-admin invitee with PLATFORM_STAFF_NOT_MEMBER; no membership appears',
    async () => {
      const r1 = await invite(P.adminA, P.tenantA, PHONE.disabledStranger);
      expect(refusal(r1)).toEqual(FORBIDDEN);
      expect(await membershipsOf(service, P.disabledStranger)).toEqual([]);
      const r2 = await invite(P.adminA, P.tenantA, PHONE.platformAdmin);
      expect(refusal(r2)).toEqual(PLATFORM_STAFF);
      expect(await membershipsOf(service, P.platformAdmin)).toEqual([]);
      expect(await auditFor(service, P.platformAdmin)).toEqual([]);
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'a missing name is filled in on an existing identity-only person, a given one is never overwritten; a blank name creates a nameless user',
    async () => {
      const r = ok(
        await invite(P.adminB, P.tenantB, PHONE.stranger, {
          name: 'MF Filled',
        }),
      );
      expect(r.invite_id).toBe(P.stranger);
      expect((await usersWithPhone(PHONE.stranger))[0].name).toBe('MF Filled');

      const phone = randomPhone();
      ok(await invite(P.adminA, P.tenantA, phone, { name: '   ' }));
      expect((await usersWithPhone(phone))[0].name).toBeNull();
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'who may invite: employee, viewer, disabled admin, removed admin, cross-company admin, stranger and unknown caller are all FORBIDDEN and change nothing',
    async () => {
      const before = await inviteAuditCount(P.tenantA);
      const callers: [string, string][] = [
        ['employee', P.employeeA],
        ['viewer', P.viewerA],
        ['disabled admin', P.disabledAdminA],
        ['removed admin', P.removedAdminA],
        ['admin of another company', P.adminB],
        ['employee of another company', P.employeeB],
        ['no membership', P.stranger],
        ['not a user at all', P.nobody],
      ];
      for (const [who, caller] of callers) {
        const phone = randomPhone();
        const r = await invite(caller, P.tenantA, phone);
        expect({ who, ...refusal(r) }).toEqual({ who, ...FORBIDDEN });
        expect(await usersWithPhone(phone)).toEqual([]);
      }
      expect(await inviteAuditCount(P.tenantA)).toBe(before);
      // A non-admin naming a company that does not exist is FORBIDDEN, not
      // "not found" (it must not reveal which company ids exist).
      const r = await invite(P.employeeA, mid('e002', 888), randomPhone());
      expect(refusal(r)).toEqual(FORBIDDEN);
    },
    RULES_TIMEOUT,
  );

  maybeIt(
    'a platform admin may invite into any company; the audit row says so; an unknown company is RESOURCE_NOT_FOUND',
    async () => {
      for (const tenant of [P.tenantA, P.tenantB]) {
        const phone = randomPhone();
        const row = ok(
          await invite(P.platformAdmin, tenant, phone, {
            role: 'viewer',
            platformAdmin: true,
          }),
        );
        const m = await membershipIn(service, row.invite_id, tenant);
        expect(m).toMatchObject({
          status: 'invited',
          role: 'viewer',
          invited_by: P.platformAdmin,
        });
        const [audit] = await auditFor(service, row.invite_id);
        expect(audit).toMatchObject({
          actor_user_id: P.platformAdmin,
          actor_is_platform_admin: true,
          tenant_id: tenant,
          action: 'member.invite',
        });
      }
      const phone = randomPhone();
      const r = await invite(P.platformAdmin, mid('e002', 888), phone, {
        platformAdmin: true,
      });
      expect(refusal(r)).toEqual(NOT_FOUND);
      expect(await usersWithPhone(phone)).toEqual([]);
    },
    RULES_TIMEOUT,
  );

  maybeIt('a platform admin who is disabled may not invite', async () => {
    await setUserFlag(service, P.platformAdmin, { disabled: true });
    try {
      const phone = randomPhone();
      const r = await invite(P.platformAdmin, P.tenantA, phone, {
        platformAdmin: true,
      });
      expect(refusal(r)).toEqual(FORBIDDEN);
      expect(await usersWithPhone(phone)).toEqual([]);
    } finally {
      await setUserFlag(service, P.platformAdmin, { disabled: false });
    }
  }, RULES_TIMEOUT);

  // Two companies racing the same NEW phone: the phone advisory lock
  // serializes them, so the loser sees the committed person and answers the
  // typed DUPLICATE_RESOURCE — never a raw 23505, never a 500.
  maybeIt(
    'two companies inviting the same NEW phone at once: exactly one wins, the other gets DUPLICATE_RESOURCE',
    async () => {
      for (let round = 0; round < 4; round++) {
        const phone = randomPhone();
        const [a, b] = await Promise.all([
          invite(P.adminA, P.tenantA, phone),
          invite(P.adminB, P.tenantB, phone),
        ]);
        const wins = [a, b].filter((r) => r.error === null);
        const losses = [a, b].filter((r) => r.error !== null);
        expect({ round, wins: wins.length }).toEqual({ round, wins: 1 });
        expect(losses).toHaveLength(1);
        expect(refusal(losses[0])).toEqual(DUPLICATE);

        const users = await usersWithPhone(phone);
        expect(users).toHaveLength(1);
        const live = (await membershipsOf(service, users[0].id)).filter(
          (m) => m.status !== 'removed',
        );
        expect(live).toHaveLength(1);
        expect(
          await auditFor(service, users[0].id, 'member.invite'),
        ).toHaveLength(1);
      }
    },
    60000,
  );

  maybeIt(
    'the same company inviting the same new phone at once: one success, the others ALREADY_IN_TEAM',
    async () => {
      const phone = randomPhone();
      const results = await Promise.all([
        invite(P.adminA, P.tenantA, phone),
        invite(P.adminA, P.tenantA, phone),
        invite(P.adminA, P.tenantA, phone),
      ]);
      expect(results.filter((r) => r.error === null)).toHaveLength(1);
      for (const r of results.filter((x) => x.error !== null)) {
        expect(refusal(r)).toEqual(ALREADY_IN_TEAM);
      }
      expect(await usersWithPhone(phone)).toHaveLength(1);
    },
    60000,
  );
});
