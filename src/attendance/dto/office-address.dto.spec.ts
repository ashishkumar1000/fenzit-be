import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOfficeDto } from './create-office.dto';
import { UpdateOfficeDto } from './update-office.dto';

const base = {
  name: 'HQ',
  latitude: 19.07,
  longitude: 72.87,
  startTime: '10:00',
  endTime: '18:00',
};

async function errorsFor<T extends object>(cls: new () => T, plain: object) {
  const inst = plainToInstance(cls, plain);
  return { inst, errors: await validate(inst as object) };
}

describe('office formattedAddress validation', () => {
  it('create: is optional', async () => {
    const { errors } = await errorsFor(CreateOfficeDto, base);
    expect(errors).toHaveLength(0);
  });

  it('create: trims surrounding spaces', async () => {
    const { inst, errors } = await errorsFor(CreateOfficeDto, {
      ...base,
      formattedAddress: '  Koramangala, Bengaluru  ',
    });
    expect(errors).toHaveLength(0);
    expect(inst.formattedAddress).toBe('Koramangala, Bengaluru');
  });

  it('create: accepts exactly 500 characters, rejects 501', async () => {
    expect((await errorsFor(CreateOfficeDto, { ...base, formattedAddress: 'a'.repeat(500) })).errors).toHaveLength(0);
    const over = await errorsFor(CreateOfficeDto, { ...base, formattedAddress: 'a'.repeat(501) });
    expect(over.errors.map((e) => e.property)).toContain('formattedAddress');
  });

  it('create: rejects a non-string address', async () => {
    const r = await errorsFor(CreateOfficeDto, { ...base, formattedAddress: 42 });
    expect(r.errors.map((e) => e.property)).toContain('formattedAddress');
  });

  it('update: is optional and capped at 500 characters', async () => {
    expect((await errorsFor(UpdateOfficeDto, {})).errors).toHaveLength(0);
    const over = await errorsFor(UpdateOfficeDto, { formattedAddress: 'a'.repeat(501) });
    expect(over.errors.map((e) => e.property)).toContain('formattedAddress');
  });

  it('update: trims surrounding spaces', async () => {
    const { inst, errors } = await errorsFor(UpdateOfficeDto, { formattedAddress: '  MG Road  ' });
    expect(errors).toHaveLength(0);
    expect(inst.formattedAddress).toBe('MG Road');
  });

  it.each(['', '   ', '\n\t', null])('treats %p as "no address" on both DTOs', async (blank) => {
    const c = await errorsFor(CreateOfficeDto, { ...base, formattedAddress: blank });
    const u = await errorsFor(UpdateOfficeDto, { formattedAddress: blank });
    expect(c.errors).toHaveLength(0);
    expect(u.errors).toHaveLength(0);
    expect(c.inst.formattedAddress).toBeUndefined();
    expect(u.inst.formattedAddress).toBeUndefined();
  });

  it('a 500-character address that is mostly spaces is judged after trimming', async () => {
    const { inst, errors } = await errorsFor(CreateOfficeDto, {
      ...base,
      formattedAddress: `  ${'a'.repeat(500)}  `,
    });
    expect(errors).toHaveLength(0);
    expect(inst.formattedAddress).toHaveLength(500);
  });
});
