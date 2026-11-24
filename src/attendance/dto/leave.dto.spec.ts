import { ValidationError, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  ApplyLeaveDto,
  ListLeaveQueryDto,
  OnBehalfLeaveDto,
  OnBehalfPreviewQueryDto,
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

  it('requires a UUID employeeId on the on-behalf variant', async () => {
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

  it('validates the employee filter as a UUID when present', async () => {
    expect(
      (
        await validate(plainToInstance(ListLeaveQueryDto, { employeeId: 'x' }))
      ).some((e) => e.property === 'employeeId'),
    ).toBe(true);
  });

  it('admits a well-formed from/to window; malformed and impossible dates fail (27-1)', async () => {
    expect(
      await validate(
        plainToInstance(ListLeaveQueryDto, {
          from: '2026-11-01',
          to: '2026-11-30',
        }),
      ),
    ).toHaveLength(0);
    expect(
      (
        await validate(plainToInstance(ListLeaveQueryDto, { from: 'garbage' }))
      ).some((e) => e.property === 'from'),
    ).toBe(true);
    // The house constraint is calendar-aware, not shape-only.
    expect(
      (
        await validate(plainToInstance(ListLeaveQueryDto, { to: '2026-02-30' }))
      ).some((e) => e.property === 'to'),
    ).toBe(true);
    // Date-time strings are not the documented YYYY-MM-DD shape.
    expect(
      (
        await validate(
          plainToInstance(ListLeaveQueryDto, {
            from: '2026-11-01T10:00:00.000Z',
          }),
        )
      ).some((e) => e.property === 'from'),
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

/**
 * The Story 1 IsUUID trap (regression pin): real user ids in the wild
 * are NOT all RFC v4 — Ajay EMP-080's id below has version nibble 'd'
 * and variant 'd', so `@IsUUID('4')` 422s on a perfectly real employee.
 * Worse, `@IsUUID()` (validator-lib 'all') ALSO rejects it — 'all' is
 * version 1-7 + 89AB variant, and 83/173 real user ids in the DB fail
 * it (hash-style seeded ids). The house contract is `@IsUUID('loose')`
 * — shape-only hex-dash, exactly NestJS ParseUUIDPipe's 'all' — on
 * every id-carrying DTO. A '4' or bare-'all' pin here reproduces as
 * "employeeId must be a UUID" on live on-behalf apply/preview.
 */
describe('the Story 1 IsUUID trap — real-world non-RFC ids must pass', () => {
  // Real-world id shape: version nibble 'd', variant 'd' — valid under
  // IsUUID('all'), REJECTED by IsUUID('4').
  const NON_V4 = '183c1349-8e1b-d7a6-d69e-be77cbc654a1';
  const range = { startDate: '2026-12-01', endDate: '2026-12-02' };

  it('OnBehalfLeaveDto accepts a non-v4 employeeId', async () => {
    const dto = plainToInstance(OnBehalfLeaveDto, {
      ...range,
      reason: 'Fever',
      employeeId: NON_V4,
    });
    expect((await validate(dto)).some((e) => e.property === 'employeeId')).toBe(
      false,
    );
  });

  it('ListLeaveQueryDto accepts a non-v4 employeeId filter', async () => {
    const dto = plainToInstance(ListLeaveQueryDto, { employeeId: NON_V4 });
    expect((await validate(dto)).some((e) => e.property === 'employeeId')).toBe(
      false,
    );
  });

  it('PreviewApplyQueryDto accepts a non-v4 leaveTypeId', async () => {
    const dto = plainToInstance(PreviewApplyQueryDto, {
      startDate: '2026-12-01',
      leaveTypeId: NON_V4,
    });
    expect(
      (await validate(dto)).some((e) => e.property === 'leaveTypeId'),
    ).toBe(false);
  });

  it('OnBehalfPreviewQueryDto accepts non-v4 employeeId + leaveTypeId', async () => {
    const dto = plainToInstance(OnBehalfPreviewQueryDto, {
      startDate: '2026-12-01',
      employeeId: NON_V4,
      leaveTypeId: NON_V4,
    });
    const props = (await validate(dto)).map((e) => e.property);
    expect(props).not.toContain('employeeId');
    expect(props).not.toContain('leaveTypeId');
  });
});
