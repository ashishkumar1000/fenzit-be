/**
 * Shared world for the SERVICE-driven invite suites: two companies, the
 * people every invite test needs, and an invite() that calls the real
 * AuthService.inviteMember — the shipped invite path since the 2026-11-25
 * EMP-code collision fix (the invite_member PL/pgSQL function is dropped;
 * these suites carry its old real-DB rules coverage on the TypeScript path).
 * Real DEV database only.
 *
 * The service writes its audit row through the real admin client, so audit
 * assertions read actual audit_log rows; teardownSuite removes them with the
 * append-only triggers temporarily off, exactly like the old RPC suites did.
 */

import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SupabaseClient } from '@supabase/supabase-js';
import { Test } from '@nestjs/testing';
import { PgPoolFactory } from '../../src/common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../../src/common/factories/supabase-client.factory';
import { OtpSessionStore } from '../../src/auth/otp-session-store';
import { SmsDeliveryProvider } from '../../src/auth/sms-delivery.provider';
import { InviteSmsService } from '../../src/auth/invite-sms/invite-sms.service';
import { AuthService } from '../../src/auth/auth.service';
import { Role } from '../../src/common/enums/role.enum';
import type { MembershipRole } from '../../src/common/enums/role.enum';
import type { RequestUser } from '../../src/common/interfaces/request-user.interface';
import {
  IS_REAL_DB,
  POINTS_AT_LIVE,
  mid,
  seedPlatformAdmin,
  setUserFlag,
} from './member-functions-fixture';
import { teardownSuite } from './member-functions-company';
import { seedCompany, serviceRoleClient } from './rls-seed';

const B = 'e002';
const P = {
  tenantA: mid(B, 1),
  tenantB: mid(B, 2),
  adminA: mid(B, 11),
  employeeA: mid(B, 12),
  viewerA: mid(B, 13),
  disabledAdminA: mid(B, 14),
  removedAdminA: mid(B, 15),
  adminB: mid(B, 21),
  employeeB: mid(B, 22),
  stranger: mid(B, 31), // identity only, no membership, no name
  disabledStranger: mid(B, 32),
  platformAdmin: mid(B, 41),
  nobody: mid(B, 99), // a uuid that is not a user at all
};
const PHONE = {
  adminA: '999860011',
  employeeA: '999860012',
  viewerA: '999860013',
  disabledAdminA: '999860014',
  removedAdminA: '999860015',
  adminB: '999860021',
  employeeB: '999860022',
  stranger: '999860031',
  disabledStranger: '999860032',
  platformAdmin: '999860041',
};
const PEOPLE = [
  P.adminA,
  P.employeeA,
  P.viewerA,
  P.disabledAdminA,
  P.removedAdminA,
  P.adminB,
  P.employeeB,
  P.stranger,
  P.disabledStranger,
  P.platformAdmin,
];

export { B, P, PHONE };

export interface InviteOk {
  invite_id: string;
  employee_code: string;
  sms_status: string;
}
/** What the service refuses with: HTTP status + the app-facing error_code. */
export interface InviteError {
  status: number;
  error_code: string;
}
export type InviteOut =
  { data: InviteOk; error: null } | { data: null; error: InviteError };

export const FORBIDDEN: InviteError = { status: 403, error_code: 'FORBIDDEN' };
export const DUPLICATE: InviteError = {
  status: 409,
  error_code: 'DUPLICATE_RESOURCE',
};
export const ALREADY_IN_TEAM: InviteError = {
  status: 409,
  error_code: 'ALREADY_IN_TEAM',
};
export const PLATFORM_STAFF: InviteError = {
  status: 400,
  error_code: 'PLATFORM_STAFF_NOT_MEMBER',
};
export const VALIDATION: InviteError = {
  status: 400,
  error_code: 'VALIDATION_ERROR',
};
export const NOT_FOUND: InviteError = {
  status: 404,
  error_code: 'RESOURCE_NOT_FOUND',
};

/** Maps a service call to the RPC-suite-style {data, error} envelope other
 *  suites speak: Nest exceptions become {status, error_code}, anything else
 *  propagates (the service's own honest-500 HttpException still maps). */
export const serviceInvite = (
  authService: AuthService,
  user: RequestUser,
  dto: {
    countryCode: string;
    phoneNumber: string;
    name: string;
    role?: MembershipRole;
    skillIds?: string[];
  },
): Promise<InviteOut> =>
  authService.inviteMember(user, dto).then(
    (data): InviteOut => ({ data, error: null }),
    (err: unknown): InviteOut => {
      if (!(err instanceof HttpException)) throw err;
      const res = err.getResponse() as { error_code?: string };
      return {
        data: null,
        error: { status: err.getStatus(), error_code: res.error_code ?? '' },
      };
    },
  );

/** One AuthService wired to the real pool + real admin client (dev creds),
 *  with everything the invite path never touches stubbed out. SMS is stubbed
 *  so a suite run never pages the provider; audits are REAL (teardownSuite
 *  cleans them). */
export async function createInviteService(): Promise<{
  authService: AuthService;
  admin: SupabaseClient;
}> {
  const configStub = {
    getOrThrow: (key: string) => {
      const v = process.env[key];
      if (v === undefined) throw new Error(`Missing env ${key}`);
      return v;
    },
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      {
        provide: OtpSessionStore,
        useValue: {
          set: jest.fn(),
          get: jest.fn(),
          delete: jest.fn(),
          increment: jest.fn(),
        },
      },
      { provide: SmsDeliveryProvider, useValue: { send: jest.fn() } },
      {
        provide: SupabaseClientFactory,
        useValue: new SupabaseClientFactory(
          configStub as unknown as ConfigService,
        ),
      },
      { provide: JwtService, useValue: { signAsync: jest.fn() } },
      {
        provide: InviteSmsService,
        useValue: {
          sendInviteSms: jest.fn().mockResolvedValue('not_configured'),
        },
      },
      {
        provide: PgPoolFactory,
        useValue: new PgPoolFactory(configStub as unknown as ConfigService),
      },
    ],
  }).compile();
  return {
    authService: moduleRef.get(AuthService),
    admin: moduleRef.get(SupabaseClientFactory).createAdmin(),
  };
}

export function useInviteServiceWorld() {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);
  let authService: AuthService | null = null;
  let skillId = '';

  type InviteOpts = {
    role?: string;
    name?: string;
    cc?: string;
    skills?: string[];
    /** The caller is Fenzit staff (platform_admin flag); tenantId names the
     *  company they are inviting into. */
    platformAdmin?: boolean;
  };

  /** Calls the real service. The caller's JWT role does not gate anything at
   *  the service boundary — runInviteTx re-checks company_admin in the DB
   *  under the locks — so a plain company_admin RequestUser is faithful for
   *  every non-staff caller, including the forbidden ones. */
  const invite = (
    caller: string,
    tenant: string,
    phone: string,
    opts: InviteOpts = {},
  ): Promise<InviteOut> => {
    if (!authService) throw new Error('world not seeded');
    const user: RequestUser = {
      userId: caller,
      tenantId: tenant,
      role: opts.platformAdmin ? Role.PLATFORM_ADMIN : Role.COMPANY_ADMIN,
      platformAdmin: opts.platformAdmin ?? false,
      rawJwt: 'probe',
    };
    const dto = {
      countryCode: opts.cc ?? '+91',
      phoneNumber: phone,
      name: opts.name ?? 'MF Invitee',
      ...(opts.role !== undefined ? { role: opts.role as MembershipRole } : {}),
      ...(opts.skills !== undefined ? { skillIds: opts.skills } : {}),
    };
    return serviceInvite(authService, user, dto);
  };

  const ok = (r: InviteOut): InviteOk => {
    expect(r.error).toBeNull();
    return r.data as InviteOk;
  };
  const refusal = (r: InviteOut): InviteError => {
    expect(r.data).toBeNull();
    return r.error as InviteError;
  };

  const usersWithPhone = async (phone: string) => {
    const { data, error } = await service
      .from('users')
      .select('id, name, country_code')
      .eq('phone_number', phone);
    expect(error).toBeNull();
    return data as { id: string; name: string | null; country_code: string }[];
  };

  const inviteAuditCount = async (tenant: string) => {
    const { count } = await service
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant)
      .eq('action', 'member.invite');
    return count ?? 0;
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    expect(POINTS_AT_LIVE).toBe(false);
    authService = (await createInviteService()).authService;
    await teardownSuite(service, [P.tenantA, P.tenantB], PEOPLE);
    await seedCompany(service, {
      tenantId: P.tenantA,
      companyName: 'IS Invite Co A',
      createdBy: P.adminA,
      people: [
        { id: P.adminA, phone: PHONE.adminA, role: 'company_admin' },
        { id: P.employeeA, phone: PHONE.employeeA, role: 'employee' },
        { id: P.viewerA, phone: PHONE.viewerA, role: 'viewer' },
        {
          id: P.disabledAdminA,
          phone: PHONE.disabledAdminA,
          role: 'company_admin',
        },
        {
          id: P.removedAdminA,
          phone: PHONE.removedAdminA,
          role: 'company_admin',
          status: 'removed',
        },
      ],
    });
    await seedCompany(service, {
      tenantId: P.tenantB,
      companyName: 'IS Invite Co B',
      createdBy: P.adminB,
      people: [
        { id: P.adminB, phone: PHONE.adminB, role: 'company_admin' },
        { id: P.employeeB, phone: PHONE.employeeB, role: 'employee' },
        { id: P.stranger, phone: PHONE.stranger, role: null },
        { id: P.disabledStranger, phone: PHONE.disabledStranger, role: null },
      ],
    });
    await setUserFlag(service, P.disabledAdminA, { disabled: true });
    await setUserFlag(service, P.disabledStranger, { disabled: true });
    await seedPlatformAdmin(service, P.platformAdmin, PHONE.platformAdmin);
    const { data: skill, error: skillError } = await service
      .from('skills')
      .select('id')
      .eq('is_active', true)
      .limit(1)
      .single();
    if (skillError || !skill) {
      throw new Error(
        `no active skill seeded on the dev database (${skillError?.message ?? 'empty catalog'}) — the unknown-skill tests need one`,
      );
    }
    skillId = (skill as { id: string }).id;
  }, 120000);

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service, [P.tenantA, P.tenantB], PEOPLE);
  }, 120000);

  return {
    maybeIt,
    service,
    invite,
    ok,
    refusal,
    usersWithPhone,
    inviteAuditCount,
    skillId: () => skillId,
  };
}
