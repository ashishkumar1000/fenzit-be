import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateContactRequestDto } from './create-contact-request.dto';

async function check(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateContactRequestDto, input);
  const errors = await validate(dto);
  return { dto, fields: errors.map((e) => e.property) };
}

describe('CreateContactRequestDto', () => {
  it('accepts a call-back request with only a phone number', async () => {
    const { fields, dto } = await check({
      kind: 'call_back',
      phone: '+91 98765 43210',
    });

    expect(fields).toEqual([]);
    expect(dto.phone).toBe('+919876543210');
  });

  it('reads a 10-digit Indian mobile without a code as +91', async () => {
    const { dto, fields } = await check({
      kind: 'call_back',
      phone: '98765-43210',
    });

    expect(fields).toEqual([]);
    expect(dto.phone).toBe('+919876543210');
  });

  it('rejects a kind other than call_back or demo', async () => {
    const { fields } = await check({
      kind: 'newsletter',
      phone: '+919876543210',
    });

    expect(fields).toContain('kind');
  });

  it('rejects a phone with no country code and too few digits', async () => {
    const { fields } = await check({ kind: 'call_back', phone: '12345' });

    expect(fields).toContain('phone');
  });

  it('treats a blank email as no email, and lower-cases a real one', async () => {
    const blank = await check({
      kind: 'demo',
      email: '   ',
      phone: '+919876543210',
    });
    expect(blank.fields).toEqual([]);
    expect(blank.dto.email).toBeUndefined();

    const upper = await check({ kind: 'demo', email: '  Ravi@Example.COM ' });
    expect(upper.fields).toEqual([]);
    expect(upper.dto.email).toBe('ravi@example.com');
  });

  it('rejects an email that the table would also refuse', async () => {
    const { fields } = await check({ kind: 'demo', email: 'not-an-email' });

    expect(fields).toContain('email');
  });

  it('caps the name and company at 120 characters', async () => {
    const at = await check({
      kind: 'demo',
      name: 'a'.repeat(120),
      company: 'b'.repeat(120),
    });
    expect(at.fields).toEqual([]);

    const over = await check({ kind: 'demo', name: 'a'.repeat(121) });
    expect(over.fields).toContain('name');
  });

  it('caps the note at 500 characters', async () => {
    const at = await check({ kind: 'demo', note: 'n'.repeat(500) });
    expect(at.fields).toEqual([]);

    const over = await check({ kind: 'demo', note: 'n'.repeat(501) });
    expect(over.fields).toContain('note');
  });

  it('rejects a non-text name instead of coercing it', async () => {
    const { fields } = await check({ kind: 'demo', name: 42 });

    expect(fields).toContain('name');
  });

  it('refuses a NUL byte in any text field, so Postgres never sees it', async () => {
    const nul = '\u0000';
    for (const input of [
      { name: `Ra${nul}vi` },
      { company: `Kumar${nul}` },
      { note: `hi${nul}` },
      { email: `ravi${nul}@example.com` },
    ]) {
      const { fields } = await check({
        kind: 'demo',
        phone: '+919876543210',
        ...input,
      });
      expect(fields).not.toEqual([]);
    }
  });

  it('accepts a phone with 7 and 15 digits after the plus, and refuses 6 and 16', async () => {
    const seven = await check({ kind: 'call_back', phone: '+1234567' });
    expect(seven.fields).toEqual([]);

    const fifteen = await check({
      kind: 'call_back',
      phone: `+1${'2'.repeat(14)}`,
    });
    expect(fifteen.fields).toEqual([]);

    const tooShort = await check({ kind: 'call_back', phone: '+123456' });
    expect(tooShort.fields).toContain('phone');

    const tooLong = await check({
      kind: 'call_back',
      phone: `+1${'2'.repeat(15)}`,
    });
    expect(tooLong.fields).toContain('phone');
  });

  it('accepts an email of exactly 254 characters and refuses 255', async () => {
    const local = 'a'.repeat(64);
    const domain = (length: number) => `${'b'.repeat(length - 4)}.com`;
    // 64 + "@" + domain = 254 when the domain is 189 characters.
    const atLimit = `${local}@${domain(189)}`;
    const overLimit = `${local}@${domain(190)}`;
    expect(atLimit.length).toBe(254);
    expect(overLimit.length).toBe(255);

    expect((await check({ kind: 'demo', email: atLimit })).fields).toEqual([]);
    expect((await check({ kind: 'demo', email: overLimit })).fields).toContain(
      'email',
    );
  });
});
