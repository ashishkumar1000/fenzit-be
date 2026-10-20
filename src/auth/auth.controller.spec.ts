import 'reflect-metadata';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ANY_MEMBER_KEY } from '../common/decorators/any-member.decorator';
import { CAN_KEY } from '../common/decorators/can.decorator';

describe('AuthController — realtime-token route', () => {
  const user: RequestUser = {
    userId: '550e8400-e29b-41d4-a716-446655440000',
    tenantId: 'tenant-uuid',
    role: Role.COMPANY_ADMIN,
    platformAdmin: false,
    rawJwt: 'login-jwt',
  };

  it('delegates to AuthService.mintRealtimeToken and returns its result', async () => {
    const minted = {
      token: 'realtime-jwt',
      expiresAt: '2026-09-09T20:00:00.000Z',
    };
    const authService = {
      mintRealtimeToken: jest.fn().mockResolvedValue(minted),
    } as unknown as AuthService;

    const controller = new AuthController(authService, {} as never);

    await expect(controller.realtimeToken(user)).resolves.toBe(minted);
    expect(authService.mintRealtimeToken).toHaveBeenCalledWith(user);
  });

  it('is open to any signed-in person — but the mint route must never accept a Realtime token back (self-renewal)', () => {
    const anyMember = Reflect.getMetadata(
      ANY_MEMBER_KEY,
      AuthController.prototype.realtimeToken,
    ) as boolean | undefined;
    const can = Reflect.getMetadata(
      CAN_KEY,
      AuthController.prototype.realtimeToken,
    ) as string[] | undefined;

    expect(anyMember).toBe(true);
    // No permission gate to narrow it: the guard rejects non-login tokens.
    expect(can).toBeUndefined();
  });
});
