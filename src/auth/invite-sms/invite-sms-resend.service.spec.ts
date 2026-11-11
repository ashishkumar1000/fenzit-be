import {
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { Role } from '../../common/enums/role.enum';
import type { RequestUser } from '../../common/interfaces/request-user.interface';
import { InviteSmsResendService } from './invite-sms-resend.service';

// Story 21-2 resend rules: admin-only, same company, pending only, cap, 429.
// The database is a fake; the company-scoped lookup is checked through the
// eq() calls it makes. Owners are stored as company_admin memberships, so the
// company_admin case covers the owner too.

const TENANT = 'tenant-1';
const MEMBER = 'member-1';
const FULL_NUMBER = '9876543210';

const INVITED_ROW = {
  user_id: MEMBER,
  role: 'employee',
  status: 'invited',
  users: { name: 'Ravi Kumar', country_code: '+91', phone_number: FULL_NUMBER },
};

function caller(
  role: Role | null,
  overrides: Partial<RequestUser> = {},
): RequestUser {
  return {
    userId: 'caller-1',
    tenantId: TENANT,
    role,
    platformAdmin: role === Role.PLATFORM_ADMIN,
    rawJwt: 'jwt',
    ...overrides,
  };
}

/** Fake of from('memberships').select().eq().eq().maybeSingle(). */
function fakeAdmin(result: { data: unknown; error: unknown }) {
  const maybeSingle = jest.fn().mockResolvedValue(result);
  const eq2 = jest.fn(() => ({ maybeSingle }));
  const eq1 = jest.fn(() => ({ eq: eq2 }));
  const select = jest.fn(() => ({ eq: eq1 }));
  const from = jest.fn(() => ({ select }));
  return { admin: { from }, from, eq1, eq2 };
}

function build(opts: {
  row?: unknown;
  readError?: unknown;
  smsStatus?: 'sent' | 'failed' | 'not_configured' | 'refused_cap';
}) {
  const db = fakeAdmin({
    data: opts.row === undefined ? INVITED_ROW : opts.row,
    error: opts.readError ?? null,
  });
  const sendInviteSms = jest.fn().mockResolvedValue(opts.smsStatus ?? 'sent');
  const factory = { createAdmin: jest.fn().mockReturnValue(db.admin) };
  const service = new InviteSmsResendService(
    { sendInviteSms } as never,
    factory as never,
  );
  return { service, sendInviteSms, db };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  try {
    await p;
  } catch (e) {
    return e as HttpException;
  }
  throw new Error('expected the call to reject');
}

describe('InviteSmsResendService: who may resend', () => {
  it('lets a company admin resend and returns the send status', async () => {
    const h = build({});
    await expect(
      h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER),
    ).resolves.toEqual({ sms_status: 'sent' });
    expect(h.sendInviteSms).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, membershipUserId: MEMBER }),
    );
  });

  it.each([
    ['an employee', caller(Role.EMPLOYEE)],
    ['a viewer', caller(Role.VIEWER)],
    ['a platform admin', caller(Role.PLATFORM_ADMIN, { tenantId: TENANT })],
    // The guard reads the platform flag, not the role, so a flagged user must
    // be refused even when the role says company_admin.
    [
      'a platform admin flagged on a company_admin role',
      caller(Role.COMPANY_ADMIN, { platformAdmin: true }),
    ],
    ['a person with no membership', caller(null)],
    [
      'a caller with no company',
      caller(Role.COMPANY_ADMIN, { tenantId: null }),
    ],
  ])(
    'refuses %s with NOT_COMPANY_ADMIN before any read or send',
    async (_label, who) => {
      const h = build({});
      const err = await errorOf(h.service.resend(who, MEMBER));
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getStatus()).toBe(403);
      expect((err.getResponse() as { error_code: string }).error_code).toBe(
        ErrorCode.NOT_COMPANY_ADMIN,
      );
      expect(h.db.from).not.toHaveBeenCalled();
      expect(h.sendInviteSms).not.toHaveBeenCalled();
    },
  );
});

describe('InviteSmsResendService: which invite can be resent', () => {
  it('scopes the lookup to the caller company', async () => {
    const h = build({});
    await h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER);
    expect(h.db.eq1).toHaveBeenCalledWith('user_id', MEMBER);
    expect(h.db.eq2).toHaveBeenCalledWith('tenant_id', TENANT);
  });

  it('answers 404 INVITE_NOT_FOUND for an unknown membership, with no send', async () => {
    const h = build({ row: null });
    const err = await errorOf(
      h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER),
    );
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err.getResponse() as { error_code: string }).error_code).toBe(
      ErrorCode.INVITE_NOT_FOUND,
    );
    expect(h.sendInviteSms).not.toHaveBeenCalled();
  });

  it('answers another company membership exactly like an unknown one', async () => {
    // The scoped query returns no row for another company's membership, so
    // the caller gets the same 404 body and cannot tell the two apart.
    const unknown = build({ row: null });
    const other = build({ row: null });
    const a = await errorOf(
      unknown.service.resend(caller(Role.COMPANY_ADMIN), 'member-of-other-co'),
    );
    const b = await errorOf(
      other.service.resend(caller(Role.COMPANY_ADMIN), MEMBER),
    );
    expect(a.getStatus()).toBe(404);
    expect(a.getResponse()).toEqual(b.getResponse());
    expect(other.sendInviteSms).not.toHaveBeenCalled();
    // The equal answers only mean isolation if the lookup itself was limited
    // to the caller's company. Check that filter on the other-company request.
    expect(other.db.eq2).toHaveBeenCalledWith('tenant_id', TENANT);
  });

  it.each(['active', 'suspended', 'removed'])(
    'answers 409 INVITE_NOT_PENDING for a %s membership, with no send',
    async (status) => {
      const h = build({ row: { ...INVITED_ROW, status } });
      const err = await errorOf(
        h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER),
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect((err.getResponse() as { error_code: string }).error_code).toBe(
        ErrorCode.INVITE_NOT_PENDING,
      );
      expect(h.sendInviteSms).not.toHaveBeenCalled();
    },
  );

  it('answers 500 and sends nothing when the lookup fails', async () => {
    const h = build({ row: null, readError: { message: 'db down' } });
    const err = await errorOf(
      h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER),
    );
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(h.sendInviteSms).not.toHaveBeenCalled();
  });

  it('answers 500 and sends nothing when the invited row has no user', async () => {
    const h = build({ row: { ...INVITED_ROW, users: null } });
    const err = await errorOf(
      h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER),
    );
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(h.sendInviteSms).not.toHaveBeenCalled();
  });
});

describe('InviteSmsResendService: cap and status', () => {
  it('turns a refused cap into 429 INVITE_SMS_LIMIT_REACHED', async () => {
    const h = build({ smsStatus: 'refused_cap' });
    const err = await errorOf(
      h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER),
    );
    expect(err.getStatus()).toBe(429);
    expect((err.getResponse() as { error_code: string }).error_code).toBe(
      ErrorCode.INVITE_SMS_LIMIT_REACHED,
    );
  });

  it('does not put the full phone number in the 429 body', async () => {
    const h = build({ smsStatus: 'refused_cap' });
    const err = await errorOf(
      h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER),
    );
    expect(JSON.stringify(err.getResponse())).not.toContain(FULL_NUMBER);
  });

  it('returns failed as a 201 status, not an error', async () => {
    const h = build({ smsStatus: 'failed' });
    await expect(
      h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER),
    ).resolves.toEqual({ sms_status: 'failed' });
  });

  it('returns not_configured while sending is off', async () => {
    const h = build({ smsStatus: 'not_configured' });
    await expect(
      h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER),
    ).resolves.toEqual({ sms_status: 'not_configured' });
  });

  it('passes the stored name, country code, number and role to the send path', async () => {
    const h = build({});
    await h.service.resend(caller(Role.COMPANY_ADMIN), MEMBER);
    expect(h.sendInviteSms).toHaveBeenCalledWith({
      tenantId: TENANT,
      membershipUserId: MEMBER,
      countryCode: '+91',
      phoneNumber: FULL_NUMBER,
      name: 'Ravi Kumar',
      role: 'employee',
    });
  });
});
