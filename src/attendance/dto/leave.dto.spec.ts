import { ValidationError, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  ApplyLeaveDto,
  ListLeaveQueryDto,
  OnBehalfLeaveDto,
  PreviewApplyQueryDto,
  RejectLeaveDto,
  RevokeLeaveDto,
} from './leave.dto';

/**
 * DTO validation matrix (QA mindset): boundaries on the reason (empty,
 * whitespace-only, 500, 501), the half-day parts, UUID v4 formats, the
 * page-size clamp inputs, and the trim transform the spec review added
 * (whitespace-only must not slip past the DB CHECK).
 */
async function validateOf<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
): Promise<ValidationError[]> {
  const instance = plainToInstance(cls as never, payload as never) as T;
  return validate(instance, { whitelist: true });
}

describe('ApplyLeaveDto', () => {
  const valid = {
    startDate: '2026-10-01',
    endDate: '2026-10-02',
    reason: 'Family function',
  };

  it('accepts a well-formed range', async () => {
    expect(await validateOf(ApplyLeaveDto, valid)).toHaveLength(0);
  });

  it('requires the reason — empty and missing both fail', async () => {
    expect(
      (await validateOf(ApplyLeaveDto, { ...valid, reason: '' })).some(
        (e) => e.property === 'reason',
      ),
    ).toBe(true);
    const { reason: _dropped, ...without } = valid;
    expect(
      (await validateOf(ApplyLeaveDto, without)).some(
        (e) => e.property === 'reason',
      ),
    ).toBe(true);
  });

  it('trims the reason; a whitespace-only reason fails after trim', async () => {
    const dto = plainToInstance(ApplyLeaveDto, { ...valid, reason: '   ' });
    expect(dto.reason).toBe('');
    expect((await validate(dto)).some((e) => e.property === 'reason')).toBe(
      true,
    );
  });

  it('accepts exactly 500 chars and rejects 501', async () => {
    expect(
      await validateOf(ApplyLeaveDto, { ...valid, reason: 'a'.repeat(500) }),
    ).toHaveLength(0);
    expect(
      (
        await validateOf(ApplyLeaveDto, { ...valid, reason: 'a'.repeat(501) })
      ).some((e) => e.property === 'reason'),
    ).toBe(true);
  });

  it('rejects malformed dates and unknown parts', async () => {
    expect(
      (
        await validateOf(ApplyLeaveDto, { ...valid, startDate: '01-10-2026' })
      ).some((e) => e.property === 'startDate'),
    ).toBe(true);
    expect(
      (await validateOf(ApplyLeaveDto, { ...valid, part: 'middle_half' })).some(
        (e) => e.property === 'part',
      ),
    ).toBe(true);
    expect(
      await validateOf(ApplyLeaveDto, { ...valid, part: 'first_half' }),
    ).toHaveLength(0);
  });

  it('requires a UUID v4 employeeId on the on-behalf variant', async () => {
    const dto = plainToInstance(OnBehalfLeaveDto, {
      ...valid,
      employeeId: 'not-a-uuid',
    });
    expect((await validate(dto)).some((e) => e.property === 'employeeId')).toBe(
      true,
    );
    const ok = plainToInstance(OnBehalfLeaveDto, {
      ...valid,
      employeeId: '22222222-2222-4222-8222-222222222222',
    });
    expect(await validate(ok)).toHaveLength(0);
  });
});

describe('RejectLeaveDto — the reason is OPTIONAL (FR-13)', () => {
  it('accepts an absent, empty-after-trim, and present reason', async () => {
    expect(await validate(plainToInstance(RejectLeaveDto, {}))).toHaveLength(0);
    expect(
      await validate(plainToInstance(RejectLeaveDto, { reason: '   ' })),
    ).toHaveLength(0);
    expect(
      await validate(plainToInstance(RejectLeaveDto, { reason: 'No budget' })),
    ).toHaveLength(0);
  });

  it('still caps the length at 500', async () => {
    expect(
      (
        await validate(
          plainToInstance(RejectLeaveDto, { reason: 'a'.repeat(501) }),
        )
      ).some((e) => e.property === 'reason'),
    ).toBe(true);
  });
});

describe('RevokeLeaveDto — the reason is REQUIRED (FR-14)', () => {
  it('rejects an absent or whitespace-only reason', async () => {
    expect(
      (await validate(plainToInstance(RevokeLeaveDto, {}))).some(
        (e) => e.property === 'reason',
      ),
    ).toBe(true);
    expect(
      (await validate(plainToInstance(RevokeLeaveDto, { reason: '  ' }))).some(
        (e) => e.property === 'reason',
      ),
    ).toBe(true);
    expect(
      await validate(
        plainToInstance(RevokeLeaveDto, { reason: 'Needed on site' }),
      ),
    ).toHaveLength(0);
  });
});

describe('ListLeaveQueryDto', () => {
  it('admits the derived statuses and coerces a numeric-string limit', async () => {
    const dto = plainToInstance(ListLeaveQueryDto, {
      status: 'pending',
      limit: '10',
    });
    expect(dto.limit).toBe(10);
    expect(await validate(dto)).toHaveLength(0);
    expect(
      (
        await validate(
          plainToInstance(ListLeaveQueryDto, { status: 'expired' }),
        )
      ).some((e) => e.property === 'status'),
    ).toBe(true);
  });

  it('validates the employee filter as a UUID v4', async () => {
    expect(
      (
        await validate(plainToInstance(ListLeaveQueryDto, { employeeId: 'x' }))
      ).some((e) => e.property === 'employeeId'),
    ).toBe(true);
  });
});

describe('PreviewApplyQueryDto', () => {
  it('accepts a start-only query and validates the part', async () => {
    expect(
      await validate(
        plainToInstance(PreviewApplyQueryDto, { startDate: '2026-10-01' }),
      ),
    ).toHaveLength(0);
    expect(
      (
        await validate(
          plainToInstance(PreviewApplyQueryDto, {
            startDate: '2026-10-01',
            part: 'third',
          }),
        )
      ).some((e) => e.property === 'part'),
    ).toBe(true);
  });
});
