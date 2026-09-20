import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  TECHNICIAN_JOB_ACTIVITY_TYPE,
  technicianJobActivityDefinition,
} from './technician-job-activity.definition';
import { fetchTechnicianJobActivityData } from './technician-job-activity.data';
import { buildTechnicianJobActivityDocument } from './technician-job-activity.template';

/**
 * The Technician Job Activity definition (story 12-5): registry identity,
 * params validation delegated to the shared util, and the fetcher/template
 * wiring the engine (story 12-3) resolves.
 */

describe('TechnicianJobActivityDefinition (story 12-5)', () => {
  it('registers under the stable reportType the FE sends', () => {
    expect(TECHNICIAN_JOB_ACTIVITY_TYPE).toBe('technician_job_activity');
    expect(technicianJobActivityDefinition.type).toBe(
      TECHNICIAN_JOB_ACTIVITY_TYPE,
    );
  });

  it('carries the human-facing label and both engine hooks', () => {
    expect(technicianJobActivityDefinition.label).toBe('Technician Job Report');
    expect(technicianJobActivityDefinition.fetchData).toBe(
      fetchTechnicianJobActivityData,
    );
    expect(technicianJobActivityDefinition.buildDocument).toBe(
      buildTechnicianJobActivityDocument,
    );
  });

  describe('validateParams', () => {
    it('normalizes camelCase body params to the stored snake_case shape', () => {
      expect(
        technicianJobActivityDefinition.validateParams({
          startDate: '2026-09-01',
          endDate: '2026-09-07',
          technicianIds: ['t1', 't2'],
        }),
      ).toEqual({
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        technician_ids: ['t1', 't2'],
      });
    });

    it('defaults missing or null technicianIds to an empty list (= all)', () => {
      expect(
        technicianJobActivityDefinition.validateParams({
          startDate: '2026-09-01',
          endDate: '2026-09-07',
        }).technician_ids,
      ).toEqual([]);
      expect(
        technicianJobActivityDefinition.validateParams({
          startDate: '2026-09-01',
          endDate: '2026-09-07',
          technicianIds: null,
        }).technician_ids,
      ).toEqual([]);
    });

    it('rejects an inverted range with VALIDATION_ERROR', () => {
      expect(() =>
        technicianJobActivityDefinition.validateParams({
          startDate: '2026-09-08',
          endDate: '2026-09-07',
        }),
      ).toThrow(BadRequestException);
      try {
        technicianJobActivityDefinition.validateParams({
          startDate: '2026-09-08',
          endDate: '2026-09-07',
        });
      } catch (e) {
        const response = (e as BadRequestException).getResponse() as Record<
          string,
          unknown
        >;
        expect(response.error_code).toBe(ErrorCode.VALIDATION_ERROR);
      }
    });

    it('rejects a malformed date with VALIDATION_ERROR', () => {
      expect(() =>
        technicianJobActivityDefinition.validateParams({
          startDate: 'not-a-date',
          endDate: '2026-09-07',
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects a range past the 92-day cap with REPORT_RANGE_TOO_LARGE', () => {
      expect(() =>
        technicianJobActivityDefinition.validateParams({
          startDate: '2026-05-31',
          endDate: '2026-08-31',
        }),
      ).toThrow(BadRequestException);
      try {
        technicianJobActivityDefinition.validateParams({
          startDate: '2026-05-31',
          endDate: '2026-08-31',
        });
      } catch (e) {
        const response = (e as BadRequestException).getResponse() as Record<
          string,
          unknown
        >;
        expect(response.error_code).toBe(ErrorCode.REPORT_RANGE_TOO_LARGE);
      }
    });
  });
});