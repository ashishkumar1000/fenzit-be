import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty, IsString, Matches } from 'class-validator';

/** The text must end in Z or a +hh:mm / -hh:mm offset, so the instant is never server-local. */
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * PUT /admin/tenants/:tenantId/validity. The date is required (null is
 * refused) and must be an ISO-8601 instant, with an offset or Z.
 */
export class TenantValidityDto {
  @ApiProperty({
    example: '2027-03-01T00:00:00.000Z',
    description: 'UTC instant the subscription ends',
  })
  @IsNotEmpty()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(HAS_OFFSET, { message: 'validUntil must end in Z or an offset such as +05:30' })
  validUntil: string;
}
