import { computeMetrics } from './technician-job-activity.metrics';
import { FetchedJob } from './technician-job-activity.data';

/**
 * Pure metric computation for the Technician Job Activity report (story 12-5,
 * PRD §4 / FR17) — no DB, exact numeric assertions.
 */

function job(overrides: Partial<FetchedJob> & { id: string }): FetchedJob {
  return {
    jobNumber: `J-${overrides.id}`,
    technicianId: 't1',
    customerId: 'c1',
    customerName: 'Customer',
    skillName: 'Plumbing',
    status: 'completed',
    priority: 'normal',
    scheduledStart: '2026-09-02T04:00:00Z',
    scheduledEnd: null,
    completedAt: null,
    photoCount: 0,
    signatureCount: 0,
    ...overrides,
  };
}

describe('TechnicianJobActivityMetrics — computeMetrics (story 12-5)', () => {
  it('computes the full PRD §4 metric set from a mixed fixture', () => {
    const jobs: FetchedJob[] = [
      // Completed, on time, urgent.
      job({
        id: 'j1',
        customerId: 'c1',
        priority: 'urgent',
        scheduledEnd: '2026-09-02T05:00:00Z',
        completedAt: '2026-09-02T04:30:00Z',
        photoCount: 2,
        signatureCount: 1,
      }),
      // Completed, late, normal.
      job({
        id: 'j2',
        customerId: 'c2',
        scheduledEnd: '2026-09-03T06:00:00Z',
        completedAt: '2026-09-03T07:00:00Z',
      }),
      // Completed but no scheduled_end — excluded from the on-time denominator.
      job({
        id: 'j3',
        customerId: 'c2',
        scheduledEnd: null,
        completedAt: '2026-09-04T07:00:00Z',
      }),
      // Open pair: one scheduled, one in progress.
      job({ id: 'j4', status: 'scheduled', customerId: 'c3' }),
      job({ id: 'j5', status: 'in_progress', customerId: 'c3' }),
      // Cancelled.
      job({ id: 'j6', status: 'cancelled', customerId: 'c4' }),
    ];

    expect(computeMetrics(jobs)).toEqual({
      totalAssigned: 6,
      completed: 3,
      cancelled: 1,
      open: 2,
      urgentCompleted: 1,
      onTimePercent: '50%',
      distinctCustomers: 4,
      photosAndSignatures: 3,
    });
  });

  it('an empty job list yields zeros and an em-dash on-time value', () => {
    expect(computeMetrics([])).toEqual({
      totalAssigned: 0,
      completed: 0,
      cancelled: 0,
      open: 0,
      urgentCompleted: 0,
      onTimePercent: '—',
      distinctCustomers: 0,
      photosAndSignatures: 0,
    });
  });

  it('renders an em-dash (never 0%) when no completed job has a scheduled_end', () => {
    const jobs: FetchedJob[] = [
      job({ id: 'j1', scheduledEnd: null, completedAt: '2026-09-02T04:30:00Z' }),
      job({ id: 'j2', status: 'cancelled' }),
    ];

    const metrics = computeMetrics(jobs);

    expect(metrics.completed).toBe(1);
    expect(metrics.onTimePercent).toBe('—');
  });

  it('counts a job finishing exactly at its scheduled end as on time', () => {
    const jobs: FetchedJob[] = [
      job({
        id: 'j1',
        scheduledEnd: '2026-09-02T05:00:00Z',
        completedAt: '2026-09-02T05:00:00Z',
      }),
    ];

    expect(computeMetrics(jobs).onTimePercent).toBe('100%');
  });

  it('excludes a completed job with a null completedAt from the on-time numerator only', () => {
    const jobs: FetchedJob[] = [
      // In denominator (has scheduled_end), not in numerator (never finished).
      job({ id: 'j1', scheduledEnd: '2026-09-02T05:00:00Z', completedAt: null }),
      job({
        id: 'j2',
        scheduledEnd: '2026-09-02T05:00:00Z',
        completedAt: '2026-09-02T04:00:00Z',
      }),
    ];

    expect(computeMetrics(jobs).onTimePercent).toBe('50%');
  });

  it('rounds the on-time percentage to the nearest whole number', () => {
    const jobs: FetchedJob[] = [
      job({
        id: 'j1',
        scheduledEnd: '2026-09-02T05:00:00Z',
        completedAt: '2026-09-02T04:00:00Z',
      }),
      job({
        id: 'j2',
        scheduledEnd: '2026-09-03T05:00:00Z',
        completedAt: '2026-09-03T06:00:00Z',
      }),
      job({
        id: 'j3',
        scheduledEnd: '2026-09-04T05:00:00Z',
        completedAt: '2026-09-04T06:00:00Z',
      }),
    ];

    // 1 of 3 = 33.33…% → 33%.
    expect(computeMetrics(jobs).onTimePercent).toBe('33%');
  });

  it('counts distinct customers across every status, deduplicated', () => {
    const jobs: FetchedJob[] = [
      job({ id: 'j1', customerId: 'c1' }),
      job({ id: 'j2', customerId: 'c1' }),
      job({ id: 'j3', customerId: 'c2', status: 'cancelled' }),
      job({ id: 'j4', customerId: 'c3', status: 'scheduled' }),
    ];

    expect(computeMetrics(jobs).distinctCustomers).toBe(3);
  });

  it('sums photos and signatures over all jobs', () => {
    const jobs: FetchedJob[] = [
      job({ id: 'j1', photoCount: 3, signatureCount: 1 }),
      job({ id: 'j2', photoCount: 0, signatureCount: 2 }),
    ];

    expect(computeMetrics(jobs).photosAndSignatures).toBe(6);
  });
});