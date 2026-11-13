import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateJobDto } from './create-job.dto';

const base = {
  customerId: '11111111-1111-4111-8111-111111111111',
  serviceLocation: 'Loc',
  skillId: '22222222-2222-4222-8222-222222222222',
  technicianId: '33333333-3333-4333-8333-333333333333',
};

async function errorsFor(extra: Record<string, unknown>) {
  const dto = plainToInstance(CreateJobDto, { ...base, ...extra });
  return validate(dto);
}

function fieldsWithErrors(errors: ValidationError[]): string[] {
  return errors.map((e) => e.property);
}

describe('CreateJobDto — schedule times must name a time zone', () => {
  it.each([
    ['a +05:30 offset', '2030-06-22T09:30:00+05:30'],
    ['a Z (UTC) suffix', '2030-06-22T09:30:00Z'],
    ['a negative offset', '2030-06-22T09:30:00-04:00'],
  ])('accepts scheduledStart with %s', async (_label, value) => {
    expect(await errorsFor({ scheduledStart: value })).toEqual([]);
  });

  it.each([
    ['no offset at all', '2030-06-22T09:30:00'],
    ['a date only', '2030-06-22'],
  ])('refuses scheduledStart with %s', async (_label, value) => {
    const errors = await errorsFor({ scheduledStart: value });
    expect(fieldsWithErrors(errors)).toContain('scheduledStart');
  });

  it('refuses a scheduledEnd with no offset', async () => {
    const errors = await errorsFor({
      scheduledStart: '2030-06-22T09:30:00+05:30',
      scheduledEnd: '2030-06-22T11:00:00',
    });
    expect(fieldsWithErrors(errors)).toContain('scheduledEnd');
  });

  it('allows scheduledEnd to be left out', async () => {
    expect(
      await errorsFor({ scheduledStart: '2030-06-22T09:30:00+05:30' }),
    ).toEqual([]);
  });
});
