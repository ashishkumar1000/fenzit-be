/**
 * invite_member core — happy path, codes, re-invite, duplicates, races (migrations 20261020000002/5/6).
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import { randomUUID } from 'crypto';
import {
  ALREADY_IN_TEAM,
  DUPLICATE,
  PLATFORM_STAFF,
  VALIDATION,
  call,
  auditFor,
  membershipIn,
  membershipsOf,
  randomPhone,
  refusal,
  seedPlatformAdmin,
} from '../helpers/member-functions-fixture';
import { P, useInviteWorld } from '../helpers/member-functions-invite-world';

describe('invite_member core (real DB)', () => {
  const {
    maybeIt,
    service,
    invite,
    ok,
    usersWithPhone,
    inviteAuditCount,
    skillId: getSkillId,
  } = useInviteWorld();
  const skillIdValue = () => getSkillId();
  maybeIt(
    'happy path: creates the person, an invited membership with an EMP- code, the skills and one audit row',
    async () => {
      const phone = randomPhone();
      const row = ok(
        await invite(P.adminA, P.tenantA, phone, {
          name: '  MF Happy  ',
          role: 'employee',
          skills: [skillIdValue()],
        }),
      );
      expect(row.was_user_created).toBe(true);
      expect(row.was_reactivated).toBe(false);
      expect(row.member_employee_code).toMatch(/^EMP-\d{3,}$/);

      const users = await usersWithPhone(phone);
      expect(users).toEqual([
        { id: row.member_user_id, name: 'MF Happy', country_code: '+91' },
      ]); // name is trimmed
      const m = await membershipIn(service, row.member_user_id, P.tenantA);
      expect(m).toMatchObject({
        id: row.member_id,
        role: 'employee',
        status: 'invited',
        employee_code: row.member_employee_code,
        invited_by: P.adminA,
      });
      const { data: skills } = await service
        .from('user_skills')
        .select('skill_id')
        .eq('user_id', row.member_user_id);
      expect(skills).toEqual([{ skill_id: skillIdValue() }]);

      const audit = await auditFor(service, row.member_user_id);
      expect(audit).toEqual([
        {
          actor_user_id: P.adminA,
          actor_is_platform_admin: false,
          tenant_id: P.tenantA,
          action: 'member.invite',
          target_user_id: row.member_user_id,
          details: { role: 'employee', reactivated: false },
        },
      ]);
    },
  );

  maybeIt(
    'each role (company_admin, employee, viewer) can be invited; any other role is refused and creates nothing',
    async () => {
      for (const role of ['company_admin', 'employee', 'viewer']) {
        const phone = randomPhone();
        const row = ok(await invite(P.adminA, P.tenantA, phone, { role }));
        expect(
          (await membershipIn(service, row.member_user_id, P.tenantA))?.role,
        ).toBe(role);
      }
      for (const role of ['platform_admin', 'owner', '', 'EMPLOYEE']) {
        const phone = randomPhone();
        const r = await invite(P.adminA, P.tenantA, phone, { role });
        expect({ role, ...refusal(r) }).toEqual({ role, ...VALIDATION });
        expect(await usersWithPhone(phone)).toEqual([]);
      }
    },
  );

  maybeIt(
    'employee codes are sequential and unique when many invites hit one company at once',
    async () => {
      const phones = [1, 2, 3, 4, 5].map(() => randomPhone());
      const results = await Promise.all(
        phones.map((p) => invite(P.adminA, P.tenantA, p)),
      );
      const rows = results.map(ok);
      const codes = rows.map((r) => r.member_employee_code);
      expect(new Set(codes).size).toBe(5);
      const nums = codes.map((c) => Number(c.slice(4))).sort((a, b) => a - b);
      for (let i = 1; i < nums.length; i++)
        expect(nums[i]).toBe(nums[i - 1] + 1);
    },
    60000,
  );

  maybeIt(
    'a removed member re-invited to the SAME company keeps the member id and employee code (new role, status invited)',
    async () => {
      const phone = randomPhone();
      const first = ok(
        await invite(P.adminA, P.tenantA, phone, { name: 'MF First Name' }),
      );
      const removed = await call(service, 'remove_member', {
        p_caller: P.adminA,
        p_tenant_id: P.tenantA,
        p_member_user_id: first.member_user_id,
      });
      expect(removed.error).toBeNull();
      expect(
        (await membershipIn(service, first.member_user_id, P.tenantA))?.status,
      ).toBe('removed');

      const again = ok(
        await invite(P.adminA, P.tenantA, phone, {
          role: 'viewer',
          name: 'MF Different Name',
        }),
      );
      expect(again.member_id).toBe(first.member_id);
      expect(again.member_user_id).toBe(first.member_user_id);
      expect(again.member_employee_code).toBe(first.member_employee_code);
      expect(again.was_reactivated).toBe(true);
      expect(again.was_user_created).toBe(false);

      const rows = await membershipsOf(service, first.member_user_id);
      expect(rows).toHaveLength(1); // no second membership row
      expect(rows[0]).toMatchObject({ status: 'invited', role: 'viewer' });
      // An existing name is never overwritten.
      expect((await usersWithPhone(phone))[0].name).toBe('MF First Name');

      const audit = await auditFor(
        service,
        first.member_user_id,
        'member.invite',
      );
      expect(audit.map((a) => a.details)).toEqual(
        expect.arrayContaining([
          { role: 'employee', reactivated: false },
          { role: 'viewer', reactivated: true },
        ]),
      );
      expect(audit).toHaveLength(2);
    },
  );

  maybeIt(
    'a person removed from company A can be invited by company B: new row and code in B, the A row stays removed',
    async () => {
      const phone = randomPhone();
      const inA = ok(await invite(P.adminA, P.tenantA, phone));
      await call(service, 'remove_member', {
        p_caller: P.adminA,
        p_tenant_id: P.tenantA,
        p_member_user_id: inA.member_user_id,
      });
      const inB = ok(await invite(P.adminB, P.tenantB, phone));
      expect(inB.member_user_id).toBe(inA.member_user_id);
      expect(inB.member_id).not.toBe(inA.member_id);
      expect(inB.was_reactivated).toBe(false);
      expect(inB.was_user_created).toBe(false);
      const rows = await membershipsOf(service, inA.member_user_id);
      expect(rows.map((r) => [r.tenant_id, r.status]).sort()).toEqual(
        [
          [P.tenantA, 'removed'],
          [P.tenantB, 'invited'],
        ].sort(),
      );
    },
  );

  maybeIt(
    'a person already invited or active anywhere is refused (ALREADY_IN_TEAM in this company, DUPLICATE_RESOURCE in another) and nothing changes',
    async () => {
      const before = await inviteAuditCount(P.tenantA);
      // Active in ANOTHER company (employeeB, seeded phone 9999700022).
      const r1 = await invite(P.adminA, P.tenantA, '9999700022');
      expect(refusal(r1)).toEqual(DUPLICATE);
      expect(await membershipIn(service, P.employeeB, P.tenantA)).toBeNull();
      // Active in the SAME company.
      const r2 = await invite(P.adminA, P.tenantA, '9999700012');
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
  );

  maybeIt(
    'two companies inviting the same NEW phone at once: exactly one wins, the other gets DUPLICATE_RESOURCE (never a raw 23505)',
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
        expect(losses[0].error?.code).not.toBe('23505');

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
    'the same company inviting the same new phone at once: one success, the other ALREADY_IN_TEAM',
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

  it('(always) suite is wired', () => {
    expect(true).toBe(true);
  });
});
