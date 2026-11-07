import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../../common/factories/supabase-client.factory';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { RequestUser } from '../../common/interfaces/request-user.interface';
import { CountryCodesService } from '../../country-codes/country-codes.service';
import { ValidateImportRowsDto } from './dto/validate-import-rows.dto';
import { validateImportRows } from './import-rows.model';
import { finaliseImportRows } from './import-rows.finalise';
import type {
  ImportRowDraft,
  ImportValidateResponse,
} from './import-rows.types';

/** Keeps each `.in()` list short so the PostgREST URL stays small. */
const LOOKUP_CHUNK_SIZE = 100;

/**
 * Stateless validation of a staff import sheet. Never writes. Tenant comes
 * from the request user (set from X-Company-Id for platform admins), never
 * from the body.
 */
@Injectable()
export class ImportValidateService {
  private readonly logger = new Logger(ImportValidateService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly countryCodes: CountryCodesService,
  ) {}

  async validate(
    owner: RequestUser,
    dto: ValidateImportRowsDto,
  ): Promise<ImportValidateResponse> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing customers',
      });
    }

    const dialCodes = (await this.countryCodes.list()).map((c) => c.dialCode);
    const defaultCountryCode = dto.defaultCountryCode ?? null;
    if (
      defaultCountryCode !== null &&
      !dialCodes.includes(defaultCountryCode)
    ) {
      throw new UnprocessableEntityException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'defaultCountryCode is not a supported country code',
      });
    }

    const drafts = validateImportRows(dto.rows, {
      dialCodes,
      defaultCountryCode,
    });
    const existing = await this.findExistingByPhone(owner.tenantId, drafts);
    return finaliseImportRows(drafts, existing);
  }

  /** Map of `countryCode|phoneNumber` to the customer id already in this tenant. */
  private async findExistingByPhone(
    tenantId: string,
    drafts: ImportRowDraft[],
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const phones = [
      ...new Set(
        drafts.flatMap((d) =>
          d.values.phoneNumber ? [d.values.phoneNumber] : [],
        ),
      ),
    ];
    const admin = this.supabaseClientFactory.createAdmin();

    for (let i = 0; i < phones.length; i += LOOKUP_CHUNK_SIZE) {
      const chunk = phones.slice(i, i + LOOKUP_CHUNK_SIZE);
      // A network fault rejects instead of returning an error. Both shapes
      // take the same path below, so the stated message and code-only log hold.
      let page: { data: unknown; error: { code?: string } | null };
      try {
        page = await admin
          .from('customers')
          .select('id, country_code, phone_number')
          .eq('tenant_id', tenantId)
          .in('phone_number', chunk);
      } catch {
        page = { data: null, error: { code: 'network' } };
      }
      const { data, error } = page;

      if (error) {
        // Logs the error code only: never the phone numbers in the sheet.
        this.logger.error(
          `Failed to look up customers for import validation (code=${error.code ?? 'none'})`,
        );
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to check existing customers',
        });
      }

      for (const row of (data ?? []) as {
        id: string;
        country_code: string;
        phone_number: string;
      }[]) {
        found.set(`${row.country_code}|${row.phone_number}`, row.id);
      }
    }
    return found;
  }
}
