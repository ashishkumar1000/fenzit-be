import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ContactRequestsService } from './contact-requests.service';
import { CreateContactRequestDto } from './dto/create-contact-request.dto';

describe('ContactRequestsService', () => {
  let insert: jest.Mock;
  let from: jest.Mock;
  let service: ContactRequestsService;

  const baseDto = (
    overrides: Partial<CreateContactRequestDto> = {},
  ): CreateContactRequestDto => ({
    kind: 'call_back',
    phone: '+919876543210',
    ...overrides,
  });

  beforeEach(() => {
    insert = jest.fn().mockResolvedValue({ error: null });
    from = jest.fn().mockReturnValue({ insert });
    const factory = {
      createAdmin: jest.fn().mockReturnValue({ from }),
    } as unknown as SupabaseClientFactory;
    service = new ContactRequestsService(factory);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a request with neither email nor phone, without touching the table', async () => {
    await expect(
      service.submit(baseDto({ phone: undefined, email: undefined })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(from).not.toHaveBeenCalled();
  });

  it('saves a call-back request and returns the call-back message', async () => {
    const message = await service.submit(baseDto());

    expect(from).toHaveBeenCalledWith('contact_requests');
    expect(insert).toHaveBeenCalledWith({
      kind: 'call_back',
      name: null,
      company: null,
      email: null,
      phone: '+919876543210',
      note: null,
    });
    expect(message).toMatch(/call you back/);
  });

  it('saves a demo request with every field and returns the demo message', async () => {
    const message = await service.submit({
      kind: 'demo',
      name: 'Ravi',
      company: 'Kumar Repairs',
      email: 'ravi@example.com',
      phone: '+919876543210',
      note: '12 technicians',
    });

    expect(insert).toHaveBeenCalledWith({
      kind: 'demo',
      name: 'Ravi',
      company: 'Kumar Repairs',
      email: 'ravi@example.com',
      phone: '+919876543210',
      note: '12 technicians',
    });
    expect(message).toMatch(/book your demo/);
  });

  it('stores blank optional text as null, not as an empty string', async () => {
    await service.submit(
      baseDto({ name: '', company: '', note: '', email: 'ravi@example.com' }),
    );

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: null, company: null, note: null }),
    );
  });

  it('accepts an email alone, with no phone', async () => {
    await service.submit(
      baseDto({ phone: undefined, email: 'ravi@example.com' }),
    );

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ravi@example.com', phone: null }),
    );
  });

  it('maps a CHECK violation (23514) to 422 instead of a server error', async () => {
    insert.mockResolvedValue({
      error: { code: '23514', message: 'check failed' },
    });

    await expect(service.submit(baseDto())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('maps any other database failure to 500 and does not log the personal details', async () => {
    insert.mockResolvedValue({
      error: { code: '08006', message: 'connection lost to ravi@example.com' },
    });
    const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await expect(
      service.submit(baseDto({ email: 'ravi@example.com', name: 'Ravi' })),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    const logged = logSpy.mock.calls.map((args) => args.join(' ')).join(' ');
    expect(logged).toContain('code=08006');
    expect(logged).not.toContain('ravi@example.com');
    expect(logged).not.toContain('+919876543210');
    expect(logged).not.toContain('Ravi');
  });

  it('keeps every submit as its own row, so a retry adds a second row', async () => {
    await service.submit(baseDto());
    await service.submit(baseDto());

    expect(insert).toHaveBeenCalledTimes(2);
  });
});
