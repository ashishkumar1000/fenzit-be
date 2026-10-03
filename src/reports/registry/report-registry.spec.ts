import { ReportRegistry } from './report-registry';
import { ATTENDANCE_REPORT_TYPE } from './attendance.definition';
import { TECHNICIAN_JOB_ACTIVITY_TYPE } from './technician-job-activity.definition';

/**
 * 21-1 review gap: the registry registration of the second report type was
 * unpinned — an unregistered type turns every attendance submit into a 400
 * "unknown report type" while every unit suite stays green.
 */
describe('ReportRegistry — both report types resolve (21-1)', () => {
  it('resolves the job report and the attendance report by their stable ids', () => {
    const registry = new ReportRegistry();
    expect(registry.get(TECHNICIAN_JOB_ACTIVITY_TYPE)?.label).toBe(
      'Technician Job Report',
    );
    expect(registry.get(ATTENDANCE_REPORT_TYPE)?.label).toBe(
      'Attendance Report',
    );
  });
});
