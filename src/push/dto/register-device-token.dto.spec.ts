import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe-options';
import { RegisterDeviceTokenDto } from './register-device-token.dto';
import { DeviceTokenParamDto } from './device-token-param.dto';

const base = { token: 'tok-abc', platform: 'android' };

async function errorsFor(
  input: Record<string, unknown>,
  cls: typeof RegisterDeviceTokenDto | typeof DeviceTokenParamDto = RegisterDeviceTokenDto,
): Promise<string[]> {
  const dto = plainToInstance(cls, input);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

describe('RegisterDeviceTokenDto', () => {
  it('accepts a minimal valid body', async () => {
    expect(await errorsFor(base)).toEqual([]);
  });

  it('accepts ios as well as android', async () => {
    expect(await errorsFor({ ...base, platform: 'ios' })).toEqual([]);
  });

  it('rejects an unknown platform', async () => {
    expect(await errorsFor({ ...base, platform: 'web' })).toEqual(['platform']);
  });

  it('rejects a missing token', async () => {
    expect(await errorsFor({ platform: 'android' })).toContain('token');
  });

  it('rejects an empty token', async () => {
    expect(await errorsFor({ ...base, token: '' })).toContain('token');
  });

  it('rejects a whitespace-only token (trimmed to empty)', async () => {
    expect(await errorsFor({ ...base, token: '   ' })).toContain('token');
  });

  it('trims a padded token so it matches the raw FCM token', async () => {
    const dto = plainToInstance(RegisterDeviceTokenDto, {
      ...base,
      token: '  tok-abc  ',
    });
    expect(dto.token).toBe('tok-abc');
  });

  it('accepts a token exactly at the 4096-char bound', async () => {
    expect(await errorsFor({ ...base, token: 'x'.repeat(4096) })).toEqual([]);
  });

  it('rejects a token one char over the 4096-char bound', async () => {
    expect(await errorsFor({ ...base, token: 'x'.repeat(4097) })).toContain('token');
  });

  it('rejects a non-string token (an array smuggled in the body)', async () => {
    expect(await errorsFor({ ...base, token: ['a', 'b'] })).toContain('token');
  });

  it('treats an omitted app version as valid (optional)', async () => {
    expect(await errorsFor(base)).toEqual([]);
  });

  it('rejects a whitespace-only app version (trimmed to empty, not "optional")', async () => {
    expect(await errorsFor({ ...base, appVersion: '   ' })).toContain('appVersion');
  });

  it('rejects an app version over 64 chars', async () => {
    expect(await errorsFor({ ...base, appVersion: 'v'.repeat(65) })).toContain('appVersion');
  });

  it('the global pipe strips a body-supplied user id (identity comes from the JWT)', async () => {
    // Runs the real global pipe options (whitelist: true), not a bare
    // transformer: a hostile userId must not survive into the DTO.
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const out = await pipe.transform(
      { ...base, userId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
      { type: 'body', metatype: RegisterDeviceTokenDto },
    );
    expect(out).not.toHaveProperty('userId');
    expect(out).toMatchObject(base);
  });
});

describe('DeviceTokenParamDto', () => {
  it('accepts a token path segment within bounds', async () => {
    expect(await errorsFor({ token: 'tok-abc' }, DeviceTokenParamDto)).toEqual([]);
  });

  it('rejects an oversized token (422, not a silent no-op)', async () => {
    expect(
      await errorsFor({ token: 'x'.repeat(4097) }, DeviceTokenParamDto),
    ).toContain('token');
  });

  it('rejects an empty token segment', async () => {
    expect(await errorsFor({ token: '' }, DeviceTokenParamDto)).toContain('token');
  });
});
