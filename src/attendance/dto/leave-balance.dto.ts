import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber, IsUUID, Max, Min } from 'class-validator';

/**
 * Leave-balance DTOs (23-13). A balance is DERIVED on read — credits +
 * accrued + carry-forward - consumed over the April-March FY named by its
 * starting April year — so every read answers numbers, never stored rows.
 */
export class CreditLeaveDto {
  @ApiProperty({
    description:
      'The employee receiving the credit (must belong to this company)',
    example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d',
  })
  @IsUUID('4', { message: 'userId must be a UUID' })
  userId!: string;

  @ApiProperty({
    description: 'The accrual-bearing leave type the credit belongs to',
    example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d',
  })
  @IsUUID('4', { message: 'leaveTypeId must be a UUID' })
  leaveTypeId!: string;

  @ApiProperty({
    description:
      'The financial year the credit belongs to, named by its starting April year (2026 = 2026-04-01..2027-03-31)',
    example: 2026,
  })
  @IsInt({ message: 'year must be a whole number' })
  @Min(2000, { message: 'year must be between 2000 and 2999' })
  @Max(2999, { message: 'year must be between 2000 and 2999' })
  year!: number;

  @ApiProperty({
    description:
      'Signed day count — positive grants, negative corrects. Never 0, at most 366 in magnitude, 2 decimal places.',
    example: 5,
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'days must be a number with at most 2 decimal places' },
  )
  @Min(-366, { message: 'days must be at most 366 in magnitude' })
  @Max(366, { message: 'days must be at most 366 in magnitude' })
  days!: number;
}

/** One balance row of the derivation, for one accrual-bearing type. */
export class LeaveBalanceView {
  @ApiProperty({ example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  typeId: string;

  @ApiProperty({
    example: 'earned',
    description:
      'earned | sick | bereavement — a legacy remnant never appears here',
  })
  code: string;

  @ApiProperty({ example: 'Earned Leave' })
  name: string;

  @ApiProperty({
    example: 'monthly',
    description: 'monthly | annual — how the type grants leave',
  })
  accrualMode: string;

  @ApiProperty({
    example: 1,
    description: 'Days per month (monthly) or the annual grant',
  })
  accrualDays: number;

  @ApiProperty({
    example: true,
    description:
      'false = a disabled type — its consumed days still count and show',
  })
  enabled: boolean;

  @ApiProperty({
    example: 0,
    description: 'Manual credits (and negative corrections) summed for this FY',
  })
  credits: number;

  @ApiProperty({
    example: 8,
    description:
      'Accrued as of today (join-month prorated; the annual grant in full)',
  })
  accrued: number;

  @ApiProperty({
    example: 0,
    description:
      'Carried forward from the completed prior FY (floored at 0; monthly carry-forward types only)',
  })
  carryForward: number;

  @ApiProperty({
    example: 2,
    description:
      'Pending + approved working days of this FY (future-dated days debit immediately)',
  })
  consumed: number;

  @ApiProperty({
    example: 6,
    description: 'credits + accrued + carry-forward - consumed',
  })
  remaining: number;
}

/** The answer of the manual credit POST. */
export class CreditView {
  @ApiProperty({ example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  id: string;

  @ApiProperty({ example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  userId: string;

  @ApiProperty({ example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  leaveTypeId: string;

  @ApiProperty({ example: 2026 })
  year: number;

  @ApiProperty({ example: 5 })
  days: number;

  @ApiProperty({ example: 'manual' })
  source: string;

  @ApiProperty({ example: '2026-11-18T10:00:00.000Z' })
  createdAt: string;
}

/** One leave-balance row inside a payslip snapshot (as of the pay-period's last day). */
export class PayslipLeaveBalance {
  @ApiProperty({ example: 'earned' })
  code: string;

  @ApiProperty({ example: 'Earned Leave' })
  name: string;

  @ApiProperty({ example: 2 })
  accrued: number;

  @ApiProperty({
    example: 1,
    description:
      'Availed: pending + approved working days up to the period end',
  })
  availed: number;

  @ApiProperty({ example: 0 })
  carryForward: number;

  @ApiProperty({ example: 1 })
  remaining: number;
}
