import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CreateContactRequestDto } from './dto/create-contact-request.dto';

const SAVED_MESSAGES = {
  call_back: 'Thanks. We will call you back on the number or email you gave.',
  demo: 'Thanks. We will be in touch to book your demo.',
} as const;

@Injectable()
export class ContactRequestsService {
  private readonly logger = new Logger(ContactRequestsService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /**
   * Saves one request and returns the message for its kind. Every request is
   * kept as its own row: a retried submit can add a second row, which the team
   * can see and close by hand. Nothing here reads or changes other rows.
   */
  async submit(dto: CreateContactRequestDto): Promise<string> {
    // The table also refuses a request with neither field (23514). This check
    // gives the person a clear message first.
    if (!dto.email && !dto.phone) {
      throw new BadRequestException(
        'Give an email address or a phone number so we can reach you',
      );
    }

    const admin = this.supabaseClientFactory.createAdmin();
    const { error } = await admin.from('contact_requests').insert({
      kind: dto.kind,
      name: dto.name || null,
      company: dto.company || null,
      email: dto.email || null,
      phone: dto.phone || null,
      note: dto.note || null,
    });

    if (error?.code === '23514') {
      // A CHECK rejected a value the API rules let through. That is bad input, not a server fault.
      throw new UnprocessableEntityException('Check the details and try again');
    }
    if (error) {
      // Never log the name, email, phone or note: they are personal data.
      this.logger.error(
        `Failed to save contact request (kind=${dto.kind}, code=${error.code ?? 'none'})`,
      );
      throw new InternalServerErrorException('Failed to save your request');
    }

    return SAVED_MESSAGES[dto.kind];
  }
}
