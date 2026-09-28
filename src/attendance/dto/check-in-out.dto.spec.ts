import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CheckInOutDto } from './check-in-out.dto';

/**
 * The AD-20 body's validation matrix (16-1/16-2, review patch): every
 * rejection here is a clean 422 before the DB is touched — the class
 * validator is the mirror of what the server then decides.
 */
describe('CheckInOutDto validation (review patch)', () => {
  function dto(overrides: Partial<CheckInOutDto> = {}): CheckInOutDto {
    return plainToInstance(CheckInOutDto, {
      latitude: 19.076,
      longitude: 72.8777,
      accuracyM: 8,
      fixAgeMs: 900,
      ...overrides,
    });
  }

  async function errors(d: CheckInOutDto): Promise<string[]> {
    const list = await validate(d, { whitelist: true });
    return list.flatMap((e) => Object.keys(e.constraints ?? {}));
  }

  it('accepts the well-formed capture', async () => {
    expect(await errors(dto())).toEqual([]);
  });

  it.each([
    ['latitude above +90', { latitude: 90.1 }],
    ['latitude below -90', { latitude: -90.1 }],
    ['longitude above +180', { longitude: 180.1 }],
    ['longitude below -180', { longitude: -180.1 }],
    ['negative accuracy', { accuracyM: -1 }],
    ['negative fixAgeMs', { fixAgeMs: -5 }],
    ['non-integer fixAgeMs', { fixAgeMs: 1.5 }],
  ])('rejects %s', async (_label, bad) => {
    expect(await errors(dto(bad))).not.toEqual([]);
  });

  it('rejects fixAgeMs above the one-day cap BEFORE the int4 column can 22003 (review finding)', async () => {
    expect(await errors(dto({ fixAgeMs: 2_147_483_648 }))).not.toEqual([]);
    expect(await errors(dto({ fixAgeMs: 86_400_001 }))).not.toEqual([]);
    expect(await errors(dto({ fixAgeMs: 86_400_000 }))).toEqual([]);
  });

  it('accepts the AD-20 tri-state mocked and coerces a string fixAgeMs', async () => {
    expect(await errors(dto({ mocked: null }))).toEqual([]);
    expect(await errors(dto({ mocked: true }))).toEqual([]);
    const coerced = plainToInstance(CheckInOutDto, {
      latitude: 19,
      longitude: 72,
      accuracyM: 8,
      fixAgeMs: '900',
    });
    expect(await errors(coerced)).toEqual([]);
  });

  it('rejects an oversized provider string', async () => {
    expect(await errors(dto({ provider: 'x'.repeat(41) }))).not.toEqual([]);
  });
});
