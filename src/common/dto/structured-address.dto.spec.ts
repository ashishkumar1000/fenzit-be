import { validate } from 'class-validator';
import { IsString } from 'class-validator';
import { StructuredAddressDto } from './structured-address.dto';

/**
 * Trivial subclass so the tests pin INHERITANCE itself: class-validator must
 * validate the base class's decorated properties on a derived instance (and
 * @nestjs/swagger must include them in the derived schema). A future refactor
 * that breaks inherited validation (e.g. switching to a non-class base or a
 * decorator-losing transform) fails these loudly.
 */
class StructuredAddressDtoSubclass extends StructuredAddressDto {
  @IsString()
  name: string = 'probe';
}

const validFields = {
  address: '12 MG Road',
  city: 'Bengaluru',
  formattedAddress: '12 MG Road, Bengaluru, Karnataka 560001, India',
  pincode: '560001',
  latitude: 12.9716,
  longitude: 77.5946,
  placeId: 'place-chennai-mg-road-01',
};

describe('StructuredAddressDto (inherited-validator pin)', () => {
  it('accepts a fully populated valid payload with no violations', async () => {
    const errors = await validate(new StructuredAddressDtoSubclass());
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty payload — every structured-address field is optional', async () => {
    const errors = await validate(new StructuredAddressDtoSubclass());
    expect(errors).toHaveLength(0);
  });

  it('rejects an over-MaxLength address through inheritance', async () => {
    const dto = new StructuredAddressDtoSubclass();
    dto.address = 'x'.repeat(300);
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('address');
  });

  it('rejects a non-Indian pincode format through inheritance', async () => {
    const dto = new StructuredAddressDtoSubclass();
    dto.pincode = '12345'; // 5 digits — the regex wants 6, starting 1-9
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('pincode');
  });

  it.each([
    ['latitude above 90', { latitude: 91 }],
    ['longitude above 180', { longitude: 181 }],
  ])('rejects %s through inheritance', async (_label, badField) => {
    const dto = new StructuredAddressDtoSubclass();
    Object.assign(dto, badField);
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
  });

  it('rejects a NaN latitude at the DTO layer (isNumber fails on NaN)', async () => {
    // Note: older class-validator lore says NaN slips past @IsNumber() — this
    // version (0.15) rejects it. The service-interface coordinate guard is
    // therefore NOT closing a DTO hole; it exists because findOrCreateByPhone
    // takes a plain input object and is callable from any module — a caller
    // that bypasses the ValidationPipe never touches these DTO validators.
    const dto = new StructuredAddressDtoSubclass();
    dto.latitude = Number.NaN;
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('latitude');
  });
});
