import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CreateEarlyAccessDto } from './dto/create-early-access.dto';

/** The row's reference code, as the database returns it (FZ-3F9A0C21). */
type ReferenceRow = { reference_code: string };

@Injectable()
export class EarlyAccessService {
  private readonly logger = new Logger(EarlyAccessService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /**
   * Saves one sign-up and returns its reference number. A repeat email is a
   * no-op, so the call is idempotent: retrying a form submit cannot create a
   * second row, and it gets back the reference it already had.
   * The first phone number given for an email is kept; a later one is not
   * written, so an existing row is never changed by a public call.
   */
  async join(dto: CreateEarlyAccessDto): Promise<string> {
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

    // Read back the reference, which is the same for a new row and a repeat email.
    // The row is already saved here, so a failure on this read is logged and
    // reported as a read failure, not as a failed save.
    const { data, error: readError } = await admin
      .from('early_access_signups')
      .select('reference_code')
      .eq('email', dto.email)
      .maybeSingle();

    const row: ReferenceRow | null = data;
    if (readError || typeof row?.reference_code !== 'string') {
      this.logger.error(
        `Failed to read early access reference (code=${readError?.code ?? 'none'})`,
      );
      throw new InternalServerErrorException(
        'Could not confirm your early access reference. Try again.',
      );
    }
    return row.reference_code;
  }
}
