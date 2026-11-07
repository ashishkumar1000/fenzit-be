import { ValidationPipe } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe-options';
import { CreateCustomerDto } from './create-customer.dto';
import { UpdateCustomerDto } from './update-customer.dto';

/**
 * QA view of manual customer create, run through the same ValidationPipe
 * config the app installs. Name and the structured-address fields are counted
 * in characters, the same rule the import uses.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const base = { countryCode: '+91', phoneNumber: '9876543210' };

const createBody = (overrides: Record<string, unknown>) => ({
  ...base,
  name: 'Asha Verma',
  ...overrides,
});

/** Runs the body through the real pipe and returns the 422 messages, or []. */
async function messagesFor(
  Metatype: new () => object,
  body: Record<string, unknown>,
): Promise<string[]> {
  try {
    await pipe.transform(body, { type: 'body', metatype: Metatype });
    return [];
  } catch (error) {
    if (error instanceof HttpException) {
      expect(error.getStatus()).toBe(422);
      const response = error.getResponse() as { message: string[] };
      return response.message;
    }
    throw error;
  }
}

describe('manual customer create: character limits (QA)', () => {
  describe('name (120 characters)', () => {
    it('accepts exactly 120 emoji', async () => {
      expect(
        await messagesFor(
          CreateCustomerDto,
          createBody({ name: '😀'.repeat(120) }),
        ),
      ).toEqual([]);
    });

    it('rejects 121 emoji with the length message', async () => {
      const messages = await messagesFor(
        CreateCustomerDto,
        createBody({ name: '😀'.repeat(121) }),
      );
      expect(messages).toEqual([
        'name must be shorter than or equal to 120 characters',
      ]);
    });

    it('rejects 120 emoji plus one letter', async () => {
      expect(
        await messagesFor(
          CreateCustomerDto,
          createBody({ name: '😀'.repeat(120) + 'a' }),
        ),
      ).toHaveLength(1);
    });

    it('rejects 121 plain letters too (the limit did not change for ASCII)', async () => {
      expect(
        await messagesFor(
          CreateCustomerDto,
          createBody({ name: 'n'.repeat(121) }),
        ),
      ).toHaveLength(1);
    });

    it('trims padding before counting: 120 emoji with spaces is accepted', async () => {
      expect(
        await messagesFor(
          CreateCustomerDto,
          createBody({ name: `   ${'😀'.repeat(120)}   ` }),
        ),
      ).toEqual([]);
    });
  });

  describe('structured-address fields (city 100, address 255, address details 255)', () => {
    it('accepts 100 emoji city and refuses 101', async () => {
      expect(
        await messagesFor(
          CreateCustomerDto,
          createBody({ city: '😀'.repeat(100) }),
        ),
      ).toEqual([]);
      expect(
        await messagesFor(
          CreateCustomerDto,
          createBody({ city: '😀'.repeat(101) }),
        ),
      ).toEqual(['city must be shorter than or equal to 100 characters']);
    });

    it('accepts 255 emoji address and refuses 256', async () => {
      expect(
        await messagesFor(
          CreateCustomerDto,
          createBody({ address: '😀'.repeat(255) }),
        ),
      ).toEqual([]);
      expect(
        await messagesFor(
          CreateCustomerDto,
          createBody({ address: '😀'.repeat(256) }),
        ),
      ).toHaveLength(1);
    });

    it('accepts 255 emoji address details and refuses 256', async () => {
      expect(
        await messagesFor(
          CreateCustomerDto,
          createBody({ addressDetails: '😀'.repeat(255) }),
        ),
      ).toEqual([]);
      expect(
        await messagesFor(
          CreateCustomerDto,
          createBody({ addressDetails: '😀'.repeat(256) }),
        ),
      ).toHaveLength(1);
    });
  });

  describe('edit (PATCH) uses the same name rule', () => {
    it('accepts 120 emoji and refuses 121 on UpdateCustomerDto', async () => {
      expect(
        await messagesFor(UpdateCustomerDto, { name: '😀'.repeat(120) }),
      ).toEqual([]);
      expect(
        await messagesFor(UpdateCustomerDto, { name: '😀'.repeat(121) }),
      ).toEqual(['name must be shorter than or equal to 120 characters']);
    });
  });
});
