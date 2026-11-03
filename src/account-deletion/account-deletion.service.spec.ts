import { InternalServerErrorException, Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import type { VerifyOtpDto } from '../auth/dto/verify-otp.dto';
import { ErrorCode } from '../common/enums/error-code.enum';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  AccountDeletionService,
  DELETION_RECEIVED_MESSAGE,
} from './account-deletion.service';

describe('AccountDeletionService', () => {
  let insert: jest.Mock;
  let maybeSingle: jest.Mock;
  let from: jest.Mock;
  let checkOtpCode: jest.Mock;
  let endOtpSession: jest.Mock;
  let service: AccountDeletionService;

  const signedIn: RequestUser = {
    userId: '0f5e6d7c-8a9b-4c0d-8e1f-2a3b4c5d6e7f',
    tenantId: null,
    role: null,
    platformAdmin: false,
    rawJwt: 'jwt-token',
  };

  const publicDto: VerifyOtpDto = {
    otpSessionId: 'session-1',
    otpCode: '123456',
  };

  beforeEach(() => {
    insert = jest.fn().mockResolvedValue({ error: null });
    maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    // The users lookup chains select().eq().eq().maybeSingle(); every other
    // table in this service is a bare from().insert().
    from = jest.fn((table: string) =>
      table === 'users'
        ? {
            select: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle }),
              }),
            }),
          }
        : { insert },
    );
    checkOtpCode = jest
      .fn()
      .mockResolvedValue({ countryCode: '+91', phoneNumber: '2121212121' });
    endOtpSession = jest.fn().mockResolvedValue(undefined);

    const factory = {
      createAdmin: jest.fn().mockReturnValue({ from }),
    } as unknown as SupabaseClientFactory;
    const authService = {
      checkOtpCode,
      endOtpSession,
    } as unknown as AuthService;
    service = new AccountDeletionService(authService, factory);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('files one signed-in request for the JWT user and answers the received message', async () => {
    const message = await service.requestForSignedIn(signedIn);

    expect(from).toHaveBeenCalledWith('account_deletion_requests');
    expect(insert).toHaveBeenCalledWith({
      user_id: signedIn.userId,
      source: 'app',
    });
    expect(message).toBe(DELETION_RECEIVED_MESSAGE);
  });

  it('answers the signed-in flow with the same message when a request is already open', async () => {
    insert.mockResolvedValue({ error: { code: '23505' } });

    await expect(service.requestForSignedIn(signedIn)).resolves.toBe(
      DELETION_RECEIVED_MESSAGE,
    );
  });

  it('throws the friendly 500 for any other database error and logs without personal data', async () => {
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    insert.mockResolvedValue({ error: { code: '23503' } });

    const error = await service
      .requestForSignedIn(signedIn)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as InternalServerErrorException).getResponse()).toEqual({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'We could not save your request. Please try again.',
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('app deletion request'),
    );
    expect(loggerError.mock.calls[0][0]).not.toContain(signedIn.userId);
  });

  it('files the public request for the account that owns the verified number', async () => {
    maybeSingle.mockResolvedValue({ data: { id: 'user-1' }, error: null });

    const message = await service.request(publicDto);

    expect(checkOtpCode).toHaveBeenCalledWith(
      publicDto.otpSessionId,
      publicDto.otpCode,
      false,
    );
    expect(endOtpSession).toHaveBeenCalledWith(publicDto.otpSessionId);
    expect(insert).toHaveBeenCalledWith({ user_id: 'user-1', source: 'web' });
    expect(message).toBe(DELETION_RECEIVED_MESSAGE);
  });

  it('answers the public flow with the same message when no account matches, without filing', async () => {
    const message = await service.request(publicDto);

    expect(insert).not.toHaveBeenCalled();
    expect(message).toBe(DELETION_RECEIVED_MESSAGE);
  });

  it('throws the friendly 500 when the public user lookup fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    maybeSingle.mockResolvedValue({ data: null, error: { code: '42P17' } });

    await expect(service.request(publicDto)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(insert).not.toHaveBeenCalled();
  });
});
