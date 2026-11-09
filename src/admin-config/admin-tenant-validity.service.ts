import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';

export interface TenantValidityResult {
  tenantId: string;
  validUntil: string;
}

@Injectable()
export class AdminTenantValidityService {
  private readonly logger = new Logger(AdminTenantValidityService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  /** Manual extension (CAP-5): sets the company's subscription end. */
  async setValidity(
    actorId: string,
    tenantId: string,
    validUntil: string,
  ): Promise<TenantValidityResult> {
    const instant = Date.parse(validUntil);
    if (!Number.isFinite(instant)) {
      throw new UnprocessableEntityException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'validUntil must be an ISO-8601 date and time',
      });
    }
    const iso = new Date(instant).toISOString();

    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('tenants')
      .update({ validity_until: iso, updated_at: new Date().toISOString() })
      .eq('id', tenantId)
      .select('id, validity_until')
      .maybeSingle<{ id: string; validity_until: string }>();
    if (error) {
      this.logger.error('Failed to set company validity:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to update the subscription end date',
      });
    }
    if (!data) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Company not found',
      });
    }
    this.logger.log(
      `Company ${tenantId} subscription end set to ${iso} by ${actorId}`,
    );
    return {
      tenantId: data.id,
      validUntil: new Date(data.validity_until).toISOString(),
    };
  }
}
