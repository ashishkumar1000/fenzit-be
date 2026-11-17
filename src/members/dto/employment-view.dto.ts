import { ApiProperty } from '@nestjs/swagger';

/**
 * The employment record behind one membership: the CAP-13 field set the
 * statutory wage slip is printed from (GET/PATCH members/:userId/employment).
 * Served to the company admin only — it never rides the member list, the
 * roster, or `/me`.
 */
export class EmploymentView {
  @ApiProperty({ example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  userId: string;

  @ApiProperty({ example: 'EMP-001' })
  employeeCode: string;

  @ApiProperty({
    example: '2026-09-01',
    nullable: true,
    description: 'Date of joining, tenant timezone; null is the run skip path',
  })
  joinDate: string | null;

  @ApiProperty({
    example: '2026-10-10',
    nullable: true,
    description: 'Date of leaving, tenant timezone',
  })
  exitDate: string | null;

  @ApiProperty({
    example: 'ABCPE1234F',
    nullable: true,
    description: 'Income-tax PAN; blank on the payslip when missing',
  })
  pan: string | null;

  @ApiProperty({ example: '1995-04-12', nullable: true })
  dateOfBirth: string | null;

  @ApiProperty({ example: 'Ramesh Sharma', nullable: true })
  fatherName: string | null;

  @ApiProperty({ example: 'Sunita Sharma', nullable: true })
  motherName: string | null;

  @ApiProperty({ example: 'Meera Sharma', nullable: true })
  spouseName: string | null;

  @ApiProperty({ example: 'PY/ABC/12345/000', nullable: true })
  pfAccountNumber: string | null;

  @ApiProperty({ example: '101234567890', nullable: true })
  uanNumber: string | null;

  @ApiProperty({ example: 'Field Technician', nullable: true })
  designation: string | null;

  @ApiProperty({ example: 'Field Operations', nullable: true })
  department: string | null;

  @ApiProperty({ example: '1234567890', nullable: true })
  bankAccountNumber: string | null;

  @ApiProperty({ example: 'HDFC0001234', nullable: true })
  ifscCode: string | null;

  @ApiProperty({ example: 'HDFC Bank', nullable: true })
  bankName: string | null;
}
