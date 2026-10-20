import { deleteAuditRows } from '../helpers/rls-seed';
/**
 * invite_member rules — validation, invitee and caller refusals, platform admin (migrations 20261020000002/5/6).
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import {
  FORBIDDEN,
  NOT_FOUND,
  PLATFORM_STAFF,
  VALIDATION,
  auditFor,
  membershipIn,
  membershipsOf,
  mid,
  randomPhone,
  refusal,
  setUserFlag,
  trackPhone,
} from '../helpers/member-functions-fixture';
import {
  B,
  P,
  PHONE,
  useInviteWorld,
} from '../helpers/member-functions-invite-world';

describe('invite_member rules (real DB)', () => {
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
    'malformed country code or phone number is refused with VALIDATION_ERROR and creates nothing',
    async () => {
      const goodPhone = () => randomPhone();
      const badCodes: (string | null)[] = [
        '91', // no plus
        '+',
        '++91',
        '+91 ',
        ' +91',
        '+12345', // 5 digits
        '+9a',
        '',
        null,
        "+91'; drop table users;--",
      ];
      for (const cc of badCodes) {
        const phone = goodPhone();
        const r = await invite(P.adminA, P.tenantA, phone, { cc });
        expect({ cc, ...refusal(r) }).toEqual({ cc, ...VALIDATION });
        expect(await usersWithPhone(phone)).toEqual([]);
      }
      const badPhones: (string | null)[] = [
        '12345', // too short
        '1234567890123456', // 16 digits
        '98765abcde',
        '98765 43210',
        ' 9876543210',
        '9876543210\n',
        '+919876543210',
        '٩٨٧٦٥٤٣٢١٠', // non-ASCII digits
        '',
        null,
      ];
      for (const phone of badPhones) {
        const r = await invite(P.adminA, P.tenantA, phone as string);
        expect({ phone, ...refusal(r) }).toEqual({ phone, ...VALIDATION });
      }
      // Boundaries that ARE valid: 6 and 15 digits, a 1-digit country code.
      const six = trackPhone(`99998${Math.floor(Math.random() * 10)}`);
      const fifteen = trackPhone(`99999${String(Date.now()).slice(-10)}`);
      for (const [cc, phone] of [
        ['+91', six],
        ['+91', fifteen],
        ['+1', trackPhone(`9${String(Date.now()).slice(-8)}`)],
      ] as const) {
        const r = await invite(P.adminA, P.tenantA, phone, { cc });
        const row = ok(r);
        await teardownExtra(row.member_user_id);
      }
    },
    90000,
  );

  maybeIt(
    'a well-formed but unsupported dial code (not in country_codes) is refused with VALIDATION_ERROR, not a raw database error',
    async () => {
      // KNOWN FAILING (reported, SQL not edited): users.country_code has a foreign
      // key to country_codes, so +1264 / +999 surface as a raw 23503 with no hint.
      const before = await inviteAuditCount(P.tenantA);
      for (const cc of ['+1264', '+999']) {
        const phone = randomPhone();
        const r = await invite(P.adminA, P.tenantA, phone, { cc });
        expect({ cc, ...refusal(r) }).toEqual({ cc, ...VALIDATION });
        expect(await usersWithPhone(phone)).toEqual([]);
      }
      expect(await inviteAuditCount(P.tenantA)).toBe(before);
    },
  );

  /** Remove a throwaway invitee made by a boundary check (keeps phones unique). */
  const teardownExtra = async (userId: string) => {
    await service.from('memberships').delete().eq('user_id', userId);
    await deleteAuditRows([], [userId]);
    await service.from('users').delete().eq('id', userId);
  };

  maybeIt(
    'an unknown skill id is refused and nothing is created (all or nothing)',
    async () => {
      const phone = randomPhone();
      const before = await inviteAuditCount(P.tenantA);
      const r = await invite(P.adminA, P.tenantA, phone, {
        skills: [skillIdValue(), mid(B, 777)],
      });
      expect(refusal(r)).toEqual(VALIDATION);
      expect(await usersWithPhone(phone)).toEqual([]);
      expect(await inviteAuditCount(P.tenantA)).toBe(before);
    },
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
  );

  maybeIt(
    'a missing name is filled in on an existing identity-only person, a given one is never overwritten; no name creates a nameless user',
    async () => {
      const r = ok(
        await invite(P.adminB, P.tenantB, PHONE.stranger, {
          name: 'MF Filled',
        }),
      );
      expect(r.member_user_id).toBe(P.stranger);
      expect(r.was_user_created).toBe(false);
      expect((await usersWithPhone(PHONE.stranger))[0].name).toBe('MF Filled');

      const phone = randomPhone();
      const blank = ok(
        await invite(P.adminA, P.tenantA, phone, { name: '   ' }),
      );
      expect((await usersWithPhone(phone))[0].name).toBeNull();
      expect(blank.was_user_created).toBe(true);
      const phone2 = randomPhone();
      ok(await invite(P.adminA, P.tenantA, phone2, { name: null }));
      expect((await usersWithPhone(phone2))[0].name).toBeNull();
    },
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
      // A non-admin naming a company that does not exist is FORBIDDEN, not "not found"
      // (it must not reveal which company ids exist).
      const r = await invite(P.employeeA, mid(B, 888), randomPhone());
      expect(refusal(r)).toEqual(FORBIDDEN);
    },
  );

  maybeIt(
    'a platform admin may invite into any company; the audit row says so; an unknown company is RESOURCE_NOT_FOUND',
    async () => {
      for (const tenant of [P.tenantA, P.tenantB]) {
        const phone = randomPhone();
        const row = ok(
          await invite(P.platformAdmin, tenant, phone, { role: 'viewer' }),
        );
        const m = await membershipIn(service, row.member_user_id, tenant);
        expect(m).toMatchObject({
          status: 'invited',
          role: 'viewer',
          invited_by: P.platformAdmin,
        });
        const [audit] = await auditFor(service, row.member_user_id);
        expect(audit).toMatchObject({
          actor_user_id: P.platformAdmin,
          actor_is_platform_admin: true,
          tenant_id: tenant,
          action: 'member.invite',
        });
      }
      const phone = randomPhone();
      const r = await invite(P.platformAdmin, mid(B, 888), phone);
      expect(refusal(r)).toEqual(NOT_FOUND);
      expect(await usersWithPhone(phone)).toEqual([]);
    },
  );

  maybeIt('a platform admin who is disabled may not invite', async () => {
    await setUserFlag(service, P.platformAdmin, { disabled: true });
    try {
      const phone = randomPhone();
      const r = await invite(P.platformAdmin, P.tenantA, phone);
      expect(refusal(r)).toEqual(FORBIDDEN);
      expect(await usersWithPhone(phone)).toEqual([]);
    } finally {
      await setUserFlag(service, P.platformAdmin, { disabled: false });
    }
  });

  it('(always) suite is wired', () => {
    expect(true).toBe(true);
  });
});
