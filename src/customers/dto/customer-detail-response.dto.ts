import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginatedResponse } from '../../common/dto/paginated-response.dto';

/**
 * Swagger-facing job-history item. Structurally identical to the
 * `JobHistoryItem` interface the service returns (job uuid + display fields),
 * declared as a class so @ApiProperty can document it.
 */
export class JobHistoryItemDto {
  @ApiProperty({
    description: 'Job uuid — use to navigate to job detail',
    example: 'a1b2c3d4-0000-4000-8000-000000000001',
  })
  id: string;

  @ApiProperty({ example: 'JOB-000001' })
  jobNumber: string;

  @ApiProperty({ example: '2026-09-01T10:00:00.000Z' })
  scheduledStart: string;

  @ApiProperty({ example: 'completed' })
  status: string;

  @ApiProperty({
    example: 'Plumbing',
    description:
      'The job skill display name (historical — rendered even if the skill is later deactivated)',
    nullable: true,
  })
  skillName: string | null;
}

/**
 * Swagger-facing shape of GET /customers/:id. Mirrors the service's
 * `CustomerDetailResponse` interface (a CustomerResponse plus jobHistory).
 */
export class CustomerDetailResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-0000-4000-8000-000000000002' })
  id: string;

  @ApiProperty({ example: 'Priya Sharma' })
  name: string;

  @ApiProperty({ example: '+91' })
  countryCode: string;

  @ApiProperty({ example: '+919876543210' })
  phoneNumber: string;

  @ApiPropertyOptional({ example: '12 MG Road', nullable: true })
  address: string | null;

  @ApiPropertyOptional({ example: 'Bengaluru', nullable: true })
  city: string | null;

  @ApiPropertyOptional({
    example: '12 MG Road, Bengaluru, Karnataka 560001, India',
    nullable: true,
  })
  formattedAddress: string | null;

  @ApiPropertyOptional({ example: '560001', nullable: true })
  pincode: string | null;

  @ApiPropertyOptional({ example: 12.9716, nullable: true })
  latitude: number | null;

  @ApiPropertyOptional({ example: 77.5946, nullable: true })
  longitude: number | null;

  @ApiPropertyOptional({
    example: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
    nullable: true,
  })
  placeId: string | null;

  @ApiProperty({
    example: 'manual',
    description: "'manual' or 'job_creation'",
  })
  createdVia: 'manual' | 'job_creation';

  @ApiProperty({ example: '2026-08-01T09:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '00000000-0000-4000-8000-000000000009' })
  tenantId: string;

  @ApiProperty({
    type: PaginatedResponse,
    description: 'Job history page (keyset-paginated, page size 20)',
  })
  jobHistory: PaginatedResponse<JobHistoryItemDto>;
}
