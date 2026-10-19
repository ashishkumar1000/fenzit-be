import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CountryCodeResponseDto } from './dto/country-code-response.dto';

/** One row of public.country_codes, as selected below. */
type CountryCodeRow = {
  dial_code: string;
  country_name: string;
  iso2: string;
};

@Injectable()
export class CountryCodesService {
  private readonly logger = new Logger(CountryCodesService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /**
   * Reference list for the phone country dropdown, read from public.country_codes.
   * Sorted by country name. The web app picks its own default (India, +91).
   */
  async list(): Promise<CountryCodeResponseDto[]> {
    // Anon client: country_codes has a public read policy, so no service role is needed.
    const publicClient = this.supabaseClientFactory.createPublic();
    const { data, error } = await publicClient
      .from('country_codes')
      .select('dial_code, country_name, iso2')
      .order('country_name', { ascending: true });

    if (error) {
      this.logger.error(
        `Failed to list country codes (code=${error.code ?? 'none'})`,
      );
      throw new InternalServerErrorException('Failed to load country codes');
    }

    const rows = (data ?? []) as CountryCodeRow[];
    return rows.map((row) => ({
      dialCode: row.dial_code,
      countryName: row.country_name,
      iso2: row.iso2,
    }));
  }
}
