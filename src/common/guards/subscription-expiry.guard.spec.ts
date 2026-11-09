import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../enums/role.enum';
import { SubscriptionExpiryGuard } from './subscription-expiry.guard';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';

/** Builds a guard whose tenants read returns the given validity_until. */
function makeGuard(validityUntil: string | null) {
  const maybeSingle = jest
    .fn()
    .mockResolvedValue({ data: { validity_until: validityUntil }, error: null });
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  const factory = { createAdmin: jest.fn().mockReturnValue({ from }) };
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
  } as unknown as Reflector;
  const guard = new SubscriptionExpiryGuard(
    reflector,
    factory as never,
  );
  return { guard, from };
}

/** An HTTP request context: an owner's POST in the given tenant. */
function ownerPost(): ExecutionContext {
  const request = {
    method: 'POST',
    user: {
      userId: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT_ID,
      role: Role.COMPANY_ADMIN,
      platformAdmin: false,
    },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('SubscriptionExpiryGuard', () => {
  it('refuses an owner write with 500 when the expiry date cannot be read', async () => {
    const { guard } = makeGuard('not-a-date');

    await expect(guard.canActivate(ownerPost())).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('refuses an owner write with 402 once the expiry date has passed', async () => {
    const { guard } = makeGuard('2020-01-01T00:00:00.000Z');

    const error = await guard.canActivate(ownerPost()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.PAYMENT_REQUIRED,
    );
  });

  it('lets an owner write through while the expiry date is in the future', async () => {
    const { guard } = makeGuard('2999-01-01T00:00:00.000Z');

    await expect(guard.canActivate(ownerPost())).resolves.toBe(true);
  });
});
