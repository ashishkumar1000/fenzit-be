import { computeFlags } from './technician-job-activity.flags';
import {
  ActivityTechnician,
  FetchedJob,
  TechnicianJobActivityData,
} from './technician-job-activity.data';

/**
 * Pure "needs attention" flag rules for the Technician Job Activity report
 * (story 12-5). `nowIso` is passed explicitly, so every rule is asserted
 * deterministically — no clock mocking.
 */

const NOW = '2026-09-20T10:00:00Z';

const TECHNICIANS: ActivityTechnician[] = [
  { id: 't1', name: 'Ravi' },
  { id: 't2', name: 'Amit' },
];

function job(overrides: Partial<FetchedJob> & { id: string }): FetchedJob {
  return {
    jobNumber: `J-${overrides.id}`,
    technicianId: 't1',
    customerId: 'c1',
    customerName: 'Customer',
    skillName: null,
    status: 'completed',
    priority: 'normal',
    scheduledStart: '2026-09-19T04:00:00Z',
    scheduledEnd: null,
    completedAt: '2026-09-19T06:00:00Z',
    photoCount: 1,
    signatureCount: 1,
    ...overrides,
  };
}

function data(jobs: FetchedJob[]): TechnicianJobActivityData {
  return {
    tenant: { companyName: 'Acme', address: null },
    range: { startDate: '2026-09-14', endDate: '2026-09-20' },
    technicians: TECHNICIANS,
    jobs,
  };
}

describe('TechnicianJobActivityFlags — computeFlags (story 12-5)', () => {
  it('returns no flags for an empty job list', () => {
    expect(computeFlags(data([]), NOW)).toEqual([]);
  });

  describe('overdue — open job past its scheduled start', () => {
    it("flags a scheduled job whose start has passed as 'Not done on time'", () => {
      const flags = computeFlags(
        data([job({ id: 'j1', status: 'scheduled' })]),
        NOW,
      );

      expect(flags).toHaveLength(1);
      expect(flags[0]).toEqual({
        jobNumber: 'J-j1',
        technicianName: 'Ravi',
        kind: 'Not done on time',
        detail: 'The planned time has passed, but the job has not started.',
      });
    });

    it("flags an in-progress job as 'Not done on time' with started wording", () => {
      const flags = computeFlags(
        data([job({ id: 'j1', status: 'in_progress' })]),
        NOW,
      );

      expect(flags).toHaveLength(1);
      expect(flags[0].kind).toBe('Not done on time');
      expect(flags[0].detail).toBe(
        'Work has started, but the planned time has passed.',
      );
    });

    it("an urgent open job is 'Urgent job not done', not 'Not done on time'", () => {
      const flags = computeFlags(
        data([job({ id: 'j1', status: 'scheduled', priority: 'urgent' })]),
        NOW,
      );

      expect(flags).toEqual([
        {
          jobNumber: 'J-j1',
          technicianName: 'Ravi',
          kind: 'Urgent job not done',
          detail:
            'This is an urgent job. Its planned time has passed and it is not done yet.',
        },
      ]);
    });

    it('an open job whose start is still in the future raises no flag', () => {
      const flags = computeFlags(
        data([
          job({ id: 'j1', status: 'scheduled', scheduledStart: '2026-09-21T04:00:00Z' }),
        ]),
        NOW,
      );

      expect(flags).toEqual([]);
    });

    it('an open job starting exactly at now is not yet overdue', () => {
      const flags = computeFlags(
        data([job({ id: 'j1', status: 'scheduled', scheduledStart: NOW })]),
        NOW,
      );

      expect(flags).toEqual([]);
    });
  });

  describe('completed without proof', () => {
    it("flags a completed job with zero photos and signatures as 'No proof of work'", () => {
      const flags = computeFlags(
        data([job({ id: 'j1', photoCount: 0, signatureCount: 0 })]),
        NOW,
      );

      expect(flags).toEqual([
        {
          jobNumber: 'J-j1',
          technicianName: 'Ravi',
          kind: 'No proof of work',
          detail:
            'The job shows as done, but no photo or signature was saved as proof.',
        },
      ]);
    });

    it('a completed job with at least one photo or signature raises no flag', () => {
      const flags = computeFlags(
        data([
          job({ id: 'j1', photoCount: 1, signatureCount: 0 }),
          job({ id: 'j2', photoCount: 0, signatureCount: 2 }),
        ]),
        NOW,
      );

      expect(flags).toEqual([]);
    });

    it("an open job past its start wins over the proof rule (flags do not double-fire)", () => {
      // A completed job is never open, but an open job with no proof must
      // surface as the overdue flag only.
      const flags = computeFlags(
        data([
          job({
            id: 'j1',
            status: 'in_progress',
            photoCount: 0,
            signatureCount: 0,
          }),
        ]),
        NOW,
      );

      expect(flags).toEqual([
        expect.objectContaining({ kind: 'Not done on time' }),
      ]);
    });
  });

  describe('cancelled', () => {
    it("flags a cancelled job as 'Cancelled'", () => {
      const flags = computeFlags(data([job({ id: 'j1', status: 'cancelled' })]), NOW);

      expect(flags).toEqual([
        {
          jobNumber: 'J-j1',
          technicianName: 'Ravi',
          kind: 'Cancelled',
          detail: 'This job was cancelled. Please check if the customer needs help.',
        },
      ]);
    });
  });

  describe('ordering and names', () => {
    it('sorts flags by severity: urgent, overdue, missing proof, cancelled', () => {
      const flags = computeFlags(
        data([
          job({ id: 'jC', status: 'cancelled' }),
          job({ id: 'jP', photoCount: 0, signatureCount: 0 }),
          job({ id: 'jO', status: 'in_progress' }),
          job({ id: 'jU', status: 'scheduled', priority: 'urgent' }),
        ]),
        NOW,
      );

      expect(flags.map((f) => f.kind)).toEqual([
        'Urgent job not done',
        'Not done on time',
        'No proof of work',
        'Cancelled',
      ]);
    });

    it('resolves technician names from the fetched section list', () => {
      const flags = computeFlags(
        data([job({ id: 'j1', technicianId: 't2', status: 'cancelled' })]),
        NOW,
      );

      expect(flags[0].technicianName).toBe('Amit');
    });

    it("an unknown technician id falls back to 'Unknown technician'", () => {
      const flags = computeFlags(
        data([job({ id: 'j1', technicianId: 't-ghost', status: 'cancelled' })]),
        NOW,
      );

      expect(flags[0].technicianName).toBe('Unknown technician');
    });
  });

  describe('plain-English copy', () => {
    it('every flag kind and detail reads as plain English sentences', () => {
      const flags = computeFlags(
        data([
          job({ id: 'j1', status: 'scheduled', priority: 'urgent' }),
          job({ id: 'j2', status: 'in_progress' }),
          job({ id: 'j3', photoCount: 0, signatureCount: 0 }),
          job({ id: 'j4', status: 'cancelled' }),
        ]),
        NOW,
      );

      for (const flag of flags) {
        expect(flag.kind).toMatch(/^[A-Za-z ]+$/);
        expect(flag.detail).toMatch(/^[A-Z].+\.$/);
        expect(flag.detail).not.toMatch(/[₹]|code|err|ID|null|undefined/);
      }
    });
  });
});