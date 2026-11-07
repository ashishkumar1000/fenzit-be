import { ValidationPipe, ArgumentMetadata } from '@nestjs/common';
import { GeocodeQueryDto } from './geocode-query.dto';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe-options';

/** Runs the same global ValidationPipe main.ts installs (trim, whitelist, 422). */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const meta: ArgumentMetadata = {
  type: 'query',
  metatype: GeocodeQueryDto,
  data: '',
};

async function accept(value: unknown): Promise<GeocodeQueryDto> {
  return (await pipe.transform(value, meta)) as GeocodeQueryDto;
}

async function reject(value: unknown): Promise<void> {
  await expect(pipe.transform(value, meta)).rejects.toMatchObject({
    status: 422,
  });
}

describe('GeocodeQueryDto (QA)', () => {
  describe('length boundaries (3..255 after trimming)', () => {
    it('should reject an empty address', async () => {
      await reject({ address: '' });
    });

    it('should reject a whitespace-only address (it trims to empty)', async () => {
      await reject({ address: '     ' });
    });

    it('should reject a 2 character address', async () => {
      await reject({ address: 'MG' });
    });

    it('should accept a 3 character address (lower boundary)', async () => {
      await expect(accept({ address: 'MGR' })).resolves.toMatchObject({
        address: 'MGR',
      });
    });

    it('should trim before measuring, so "  ab  " is still too short', async () => {
      await reject({ address: '  ab  ' });
    });

    it('should accept exactly 255 characters (upper boundary)', async () => {
      const address = 'a'.repeat(255);
      await expect(accept({ address })).resolves.toMatchObject({ address });
    });

    it('should reject 256 characters', async () => {
      await reject({ address: 'a'.repeat(256) });
    });

    it('should measure 255 after trimming, so padding does not push a valid address over the limit', async () => {
      const inner = 'b'.repeat(255);
      const dto = await accept({ address: `   ${inner}   ` });
      expect(dto.address).toBe(inner);
    });
  });

  describe('trimming', () => {
    it('should strip leading and trailing whitespace from the stored value', async () => {
      await expect(
        accept({ address: '  12 MG Road, Bengaluru \t' }),
      ).resolves.toMatchObject({
        address: '12 MG Road, Bengaluru',
      });
    });

    it('should keep internal spacing unchanged', async () => {
      await expect(accept({ address: 'MG    Road' })).resolves.toMatchObject({
        address: 'MG    Road',
      });
    });
  });

  describe('type safety of the query value', () => {
    it('should reject a missing address key', async () => {
      await reject({});
    });

    it('should reject a null address', async () => {
      await reject({ address: null });
    });

    it('should reject a numeric address', async () => {
      await reject({ address: 560001 });
    });

    it('should reject a repeated query parameter (address arrives as an array)', async () => {
      await reject({ address: ['MG Road', 'Church Street'] });
    });

    it('should reject a nested object address', async () => {
      await reject({ address: { street: 'MG Road' } });
    });
  });

  describe('adversarial but valid-length strings (accepted as opaque text)', () => {
    it('should accept SQL-looking text and keep it verbatim (sanitising is not the DTO job)', async () => {
      const sqlish = "'; DROP TABLE users; --";
      await expect(accept({ address: sqlish })).resolves.toMatchObject({
        address: sqlish,
      });
    });

    it('should accept a Devanagari address of 3 or more characters', async () => {
      await expect(accept({ address: 'मुंबई' })).resolves.toMatchObject({
        address: 'मुंबई',
      });
    });

    it('should drop unknown extra fields (whitelist), so a client cannot smuggle lat/lng in', async () => {
      const dto = await accept({
        address: 'MG Road',
        latitude: 1,
        longitude: 2,
      });
      expect(dto).not.toHaveProperty('latitude');
      expect(dto).not.toHaveProperty('longitude');
      const allowed = ['name', 'address', 'city', 'state', 'pincode'];
      expect(Object.keys(dto).filter((key) => !allowed.includes(key))).toEqual(
        [],
      );
      expect(dto.address).toBe('MG Road');
    });
  });
});
