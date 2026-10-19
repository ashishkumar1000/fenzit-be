import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CreateEarlyAccessDto } from './dto/create-early-access.dto';

@Injectable()
export class EarlyAccessService {
  private readonly logger = new Logger(EarlyAccessService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /**
   * Saves one sign-up. A repeat email is a no-op, which makes the call
   * idempotent: retrying a form submit cannot create a second row.
   * The first phone number given for an email is kept; a later one is not
   * written, so an existing row is never changed by a public call.
   */
  async join(dto: CreateEarlyAccessDto): Promise<void> {
    const admin = this.supabaseClientFactory.createAdmin();
    const { error } = await admin
      .from('early_access_signups')
      .upsert(
        { email: dto.email, phone: dto.phone ?? null },
        { onConflict: 'email', ignoreDuplicates: true },
      );

    if (error?.code === '23514') {
      // A database CHECK rejected a value the API rules let through (for example
      // an email the regex in the table does not accept). That is bad input, not a server fault.
      throw new UnprocessableEntityException(
        'Check the email and phone and try again',
      );
    }
    if (error) {
      // Never log the email or phone: they are personal data.
      this.logger.error(
        `Failed to save early access sign-up (code=${error.code ?? 'none'})`,
      );
      throw new InternalServerErrorException(
        'Failed to save early access sign-up',
      );
    }
  }
}
