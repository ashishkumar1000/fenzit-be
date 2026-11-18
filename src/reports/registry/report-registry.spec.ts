import { ReportRegistry } from './report-registry';
import { ATTENDANCE_REPORT_TYPE } from './attendance.definition';
import { TECHNICIAN_JOB_ACTIVITY_TYPE } from './technician-job-activity.definition';
import { PAYSLIP_REPORT_TYPE } from './payslip.definition';

/**
 * 21-1 review gap: the registry registration of the second report type was
 * unpinned — an unregistered type turns every attendance submit into a 400
 * "unknown report type" while every unit suite stays green. The payslip
 * type joins the same pin (23-8 second-pass review): an unregistered payslip
 * would fail every PDF request at the engine while the unit specs stay green.
 */
describe('ReportRegistry — all report types resolve', () => {
  const registry = new ReportRegistry();

  it('resolves the job report and the attendance report by their stable ids', () => {
    expect(registry.get(TECHNICIAN_JOB_ACTIVITY_TYPE)?.label).toBe(
      'Technician job report',
    );
    expect(registry.get(ATTENDANCE_REPORT_TYPE)?.label).toBe(
      'Attendance report',
    );
  });

  it('resolves the payslip PDF by its stable id, gate wired (23-8)', () => {
    const definition = registry.get(PAYSLIP_REPORT_TYPE);
    expect(definition?.label).toBe('Payslip');
    // The supersession gate rides the registration, not just the fetcher.
    expect(definition?.verifyBeforeReady).toBeDefined();
  });
});
