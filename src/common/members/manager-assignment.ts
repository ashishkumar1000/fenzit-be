import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { ErrorCode } from '../enums/error-code.enum';
import { MAX_HIERARCHY_DEPTH, probeManagerAssignment } from './hierarchy';

/**
 * The guards every "X reports to Y" write shares: `PATCH /members/:id/manager`
 * and the invite's optional `managerId`. One copy so the two paths cannot
 * drift on status codes or wording (they already had).
 *
 * Order matters: self first (no lookups needed), then existence inside the
 * company (a foreign id answers the same not-found as an absent one), then
 * the manager's live state, then the tree checks.
 */
export async function assertManagerAssignable(
  tx: PoolClient,
  tenantId: string,
  memberUserId: string,
  managerId: string,
): Promise<void> {
  if (managerId === memberUserId) {
    throw new UnprocessableEntityException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'A person cannot report to themselves',
    });
  }

  // No status filter: the row is read whatever its state so a `removed` or
  // invited manager can be told apart from a foreign id (which is 404).
  // `for share` keeps a concurrent disable or removal from landing between the
  // check and the pointer write.
  const managerRes = await tx.query<{
    status: string;
    disabled: boolean;
  }>(
    `select m.status, u.disabled
       from public.memberships m
       join public.users u on u.id = m.user_id
      where m.user_id = $1 and m.tenant_id = $2
      for share`,
    [managerId, tenantId],
  );
  const manager = managerRes.rows[0];
  if (!manager) {
    throw new NotFoundException({
      error_code: ErrorCode.RESOURCE_NOT_FOUND,
      message: 'Not found',
    });
  }
  if (manager.status !== 'active' || manager.disabled) {
    throw new UnprocessableEntityException({
      error_code: ErrorCode.MANAGER_NOT_ACTIVE,
      message:
        'That person is not an active member of the company, so they cannot be a reporting manager',
    });
  }

  const probe = await probeManagerAssignment(
    tx,
    tenantId,
    memberUserId,
    managerId,
  );
  if (probe.cycle) {
    throw new ConflictException({
      error_code: ErrorCode.HIERARCHY_CYCLE,
      message:
        'That person already reports to this person, directly or through someone else',
    });
  }
  // Level 1 is the admins; the member lands one below the chosen manager, and
  // their own branch continues below them.
  if (probe.managerAncestors + 2 + probe.subtreeDepth > MAX_HIERARCHY_DEPTH) {
    throw new ConflictException({
      error_code: ErrorCode.HIERARCHY_DEPTH,
      message: `That would make the team more than ${MAX_HIERARCHY_DEPTH} levels deep — pick a manager higher up`,
    });
  }
}
