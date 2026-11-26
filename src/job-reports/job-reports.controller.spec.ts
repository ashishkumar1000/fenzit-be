import { CAN_KEY } from '../common/decorators/can.decorator';
import { Permission } from '../common/permissions/permissions';
import {
  ApprovalQueueController,
  JobReportsController,
} from './job-reports.controller';

/**
 * 24-4 — `job.approve` became tree-derived (employees and viewers hold it so a
 * manager can reach the decision service), so the two tenant-wide owner
 * surfaces must NOT be gated on it: an employee would otherwise read every
 * colleague's pending jobs and the whole owner report.
 */
function permissionOf(proto: object, handler: string): unknown {
  const fn = (proto as Record<string, unknown>)[handler] as object;
  return Reflect.getMetadata(CAN_KEY, fn);
}

describe('job report and approval-queue route permissions (24-4)', () => {
  it.each<[string, Permission]>([
    ['ownerReport', 'job.reports'],
    ['employeeReport', 'job.read_own'],
  ])('JobReportsController.%s is gated by %s', (handler, permission) => {
    expect(permissionOf(JobReportsController.prototype, handler)).toEqual([
      permission,
    ]);
  });

  it.each<[string, Permission]>([
    ['list', 'job.reports'],
    ['listMine', 'job.read_own'],
  ])('ApprovalQueueController.%s is gated by %s', (handler, permission) => {
    expect(permissionOf(ApprovalQueueController.prototype, handler)).toEqual([
      permission,
    ]);
  });
});
