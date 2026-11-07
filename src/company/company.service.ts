import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import {
  BusinessTypeItem,
  listActiveBusinessTypes,
  loadTenantBusinessTypes,
} from './business-types.repo';
import { UpdateCompanyDto } from './dto/update-company.dto';

/** The company details the app shows — same shape from GET /users/me and PATCH /company. */
export interface CompanySummary {
  id: string;
  companyName: string;
  gstin: string | null;
  address: string | null;
  stateCode: string;
  upiVpa: string | null;
  businessTypes: BusinessTypeItem[];
}

interface TenantRow {
  id: string;
  company_name: string;
  gstin: string | null;
  address: string | null;
  state_code: string;
  upi_vpa: string | null;
}

@Injectable()
export class CompanyService {
  private readonly logger = new Logger(CompanyService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /** Active business types, for the picker. */
  async listBusinessTypes(): Promise<{ businessTypes: BusinessTypeItem[] }> {
    try {
      const admin = this.supabaseClientFactory.createAdmin();
      return { businessTypes: await listActiveBusinessTypes(admin) };
    } catch (error: unknown) {
      this.logger.error('Failed to list business types:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to load business types',
      });
    }
  }

  /**
   * Owner-only (the route carries `@Can('company.manage')`). Tenant comes from
   * the verified request user, never from the body.
   */
  async updateCompany(
    user: RequestUser,
    dto: UpdateCompanyDto,
  ): Promise<CompanySummary> {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required',
      });
    }
    const tenantId = user.tenantId;
    const admin = this.supabaseClientFactory.createAdmin();

    try {
      // Types first: the set is written add-then-remove, so the company never
      // sits with no types between the two steps.
      if (dto.businessTypeCodes !== undefined) {
        await this.replaceBusinessTypes(admin, tenantId, dto.businessTypeCodes);
      }

      if (dto.gstin !== undefined) {
        const { error } = await admin
          .from('tenants')
          .update({ gstin: dto.gstin, updated_at: new Date().toISOString() })
          .eq('id', tenantId);
        if (error) throw error;
      }

      return await this.getCompany(admin, tenantId);
    } catch (error: unknown) {
      if (error instanceof UnprocessableEntityException) throw error;
      this.logger.error('Failed to update company:', { error, tenantId });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to update company',
      });
    }
  }

  /** The company's details as the app shows them. */
  async getCompany(
    admin: SupabaseClient,
    tenantId: string,
  ): Promise<CompanySummary> {
    const { data, error } = await admin
      .from('tenants')
      .select('id, company_name, gstin, address, state_code, upi_vpa')
      .eq('id', tenantId)
      .single<TenantRow>();
    if (error || !data) throw error ?? new Error('tenant not found');

    return {
      id: data.id,
      companyName: data.company_name,
      gstin: data.gstin,
      address: data.address,
      stateCode: data.state_code,
      upiVpa: data.upi_vpa,
      businessTypes: await loadTenantBusinessTypes(admin, tenantId),
    };
  }

  /**
   * Makes the company's set equal to `codes`. Unknown or inactive codes are a
   * 422 before anything is written. Insert first, then delete the rest.
   */
  private async replaceBusinessTypes(
    admin: SupabaseClient,
    tenantId: string,
    codes: string[],
  ): Promise<void> {
    const { data: catalog, error: catalogError } = await admin
      .from('business_types')
      .select('id, code')
      .in('code', codes)
      .eq('is_active', true)
      .returns<{ id: string; code: string }[]>();
    if (catalogError) throw catalogError;

    const ids = (catalog ?? []).map((row) => row.id);
    if (ids.length !== new Set(codes).size) {
      throw new UnprocessableEntityException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'One or more business types are not recognised',
      });
    }

    if (ids.length > 0) {
      const { error: upsertError } = await admin
        .from('tenant_business_types')
        .upsert(
          ids.map((id) => ({ tenant_id: tenantId, business_type_id: id })),
          { onConflict: 'tenant_id,business_type_id', ignoreDuplicates: true },
        );
      if (upsertError) throw upsertError;
    }

    let removeQuery = admin
      .from('tenant_business_types')
      .delete()
      .eq('tenant_id', tenantId);
    if (ids.length > 0) {
      removeQuery = removeQuery.not(
        'business_type_id',
        'in',
        `(${ids.join(',')})`,
      );
    }
    const { error: removeError } = await removeQuery;
    if (removeError) throw removeError;
  }
}
