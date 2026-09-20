import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateReportRequestDto } from './create-report-request.dto';

/**
 * The create DTO pins SHAPE only — calendar dates, the 92-day cap, the IST
 * future check and technician membership are deep validation in the report
 * definition + service (see the DTO's doc comment), so failures there map to
 * 400s with specific error codes, not a generic 422. These tests pin the
 * shape constraints and the trim transform; nothing more.
 */
async function validateBody(body: Record<string, unknown>) {
  return validate(plainToInstance(CreateReportRequestDto, body));
}

describe('CreateReportRequestDto — shape-only constraints (story 12-2)', () => {
  const valid = { startDate: '2026-08-01', endDate: '2026-08-07' };

  it('accepts the minimal body (reportType and technicianIds are optional)', async () => {
    const errors = await validateBody(valid);
    expect(errors).toHaveLength(0);
  });

  it('accepts a full body with a technician id array', async () => {
    const errors = await validateBody({
      ...valid,
      reportType: 'technician_job_activity',
      technicianIds: ['t-1', 't-2'],
    });
    expect(errors).toHaveLength(0);
  });

  it('applies the trim transform to the string fields', async () => {
    const dto = plainToInstance(CreateReportRequestDto, {
      ...valid,
      startDate: ' 2026-08-01 ',
      reportType: ' technician_job_activity ',
    });
    expect(dto.startDate).toBe('2026-08-01');
    expect(dto.reportType).toBe('technician_job_activity');
  });

  it('rejects a missing startDate or endDate', async () => {
    const errors = await validateBody({});
    const props = errors.map((e) => e.property);
    expect(props).toContain('startDate');
    expect(props).toContain('endDate');
  });

  it('rejects a startDate longer than 10 chars (not a YYYY-MM-DD shape)', async () => {
    const errors = await validateBody({
      ...valid,
      startDate: '2026-08-01T00:00',
    });
    expect(errors.map((e) => e.property)).toContain('startDate');
    expect(errors.find((e) => e.property === 'startDate')?.constraints).toHaveProperty(
      'maxLength',
    );
  });

  it('rejects a reportType longer than 64 chars', async () => {
    const errors = await validateBody({
      ...valid,
      reportType: 'x'.repeat(65),
    });
    expect(errors.map((e) => e.property)).toContain('reportType');
  });

  it('rejects a non-array technicianIds', async () => {
    const errors = await validateBody({
      ...valid,
      technicianIds: 't-1',
    });
    expect(errors.map((e) => e.property)).toContain('technicianIds');
    expect(
      errors.find((e) => e.property === 'technicianIds')?.constraints,
    ).toHaveProperty('isArray');
  });

  it('rejects a technicianIds array with non-string elements', async () => {
    const errors = await validateBody({
      ...valid,
      technicianIds: ['t-1', 42],
    });
    expect(errors.map((e) => e.property)).toContain('technicianIds');
  });
});