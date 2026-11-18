import { ApiProperty } from '@nestjs/swagger';

export class LockView {
  @ApiProperty({ example: '2026-10' })
  month: string;

  @ApiProperty({ example: '2026-11-18T10:00:00.000Z' })
  lockedAt: string;

  @ApiProperty({
    example: '9f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d',
    description: 'The admin who locked the month.',
  })
  lockedBy: string;

  @ApiProperty({
    description:
      'The confirmation the admin accepted: the permanence statement, the off-cycle remedy, and how many staged off-cycle lines the month already carries.',
  })
  confirmation: Record<string, unknown>;
}

export class AuditEntryView {
  @ApiProperty({ example: '9f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  id: string;

  @ApiProperty({ example: '2026-11-18T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({
    example: '9f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d',
    description: 'The admin who made the change.',
  })
  actorId: string;

  @ApiProperty({
    example: 'payroll.month_locked',
    description: 'A `payroll.*` action — one entry per real payroll change.',
  })
  action: string;

  @ApiProperty({
    nullable: true,
    example: '7c2ba7bc-995a-4c57-8e69-2ac1cd0b8f10',
    description: 'The employee the change was about, when there was one.',
  })
  targetUserId: string | null;

  @ApiProperty({
    description: 'The change specifics (month, field, amounts…).',
  })
  details: Record<string, unknown>;
}
