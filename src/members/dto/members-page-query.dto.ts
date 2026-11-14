import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  MEMBERSHIP_ROLES,
  type MembershipRole,
} from '../../common/enums/role.enum';

const STATUS_FILTERS = ['all', 'active', 'invited'] as const;
const JOB_SETTING_FILTERS = ['all', 'create', 'off'] as const;
const SORTS = ['joined_new', 'joined_old', 'name_az'] as const;

type RoleFilter = 'all' | MembershipRole;
type StatusFilter = (typeof STATUS_FILTERS)[number];
type JobSettingFilter = (typeof JOB_SETTING_FILTERS)[number];
type Sort = (typeof SORTS)[number];

/**
 * Query for GET /members/page — the console's paged team list. Every filter is
 * optional; with none, the list is the whole team, newest join first. The
 * filtering and paging happen in the service over the plain members read —
 * no database function.
 */
export class MembersPageQueryDto {
  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 10, default: 10, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({
    example: 'amit',
    description:
      'Matches the name, employee code or phone number (digits) — case-insensitive "contains".',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ enum: STATUS_FILTERS, default: 'all' })
  @IsOptional()
  @IsIn(STATUS_FILTERS, { message: 'status must be all, active or invited' })
  status?: StatusFilter;

  @ApiPropertyOptional({ enum: ['all', ...MEMBERSHIP_ROLES], default: 'all' })
  @IsOptional()
  @IsIn(['all', ...MEMBERSHIP_ROLES] as RoleFilter[], {
    message: 'role must be all, company_admin, employee or viewer',
  })
  role?: RoleFilter;

  @ApiPropertyOptional({
    enum: JOB_SETTING_FILTERS,
    default: 'all',
    description:
      'Filter by the job-settings switches: may create jobs, or not.',
  })
  @IsOptional()
  @IsIn(JOB_SETTING_FILTERS, {
    message: 'jobSetting must be all, create or off',
  })
  jobSetting?: JobSettingFilter;

  @ApiPropertyOptional({ enum: SORTS, default: 'joined_new' })
  @IsOptional()
  @IsIn(SORTS, { message: 'sort must be joined_new, joined_old or name_az' })
  sort?: Sort;
}
