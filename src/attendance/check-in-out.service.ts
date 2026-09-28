import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { CHECKIN_MAX_ACCURACY_M, FIX_MAX_AGE_MS } from './constants';
import { haversineDistanceM } from './geo';
import { buildDayContext } from './day-context.read';
import { internalError, requireTenant } from './attendance-rpc.helpers';
import { lockTenantShared, tenantToday } from './enrolments.repository';
import {
  AttemptKind,
  findAttemptByIdempotencyKey,
  insertAttempt,
  lockEmployee,
  readActiveBlockedUntil,
} from './check-in-out.repository';
import {
  findRecordByEmployeeDate,
  insertRecord,
  RecordRow,
  updateRecordCheckout,
} from './check-in-out.records.repository';
import {
  CheckInResponse,
  CheckOutResponse,
  outcomeToException,
  recordToResponse,
  toAttemptLocation,
} from './check-in-out.model';
import { metricsFor, replayResponse, toFlags } from './check-in-out.replay';
import {
  duplicateKeyRejection,
  rejectCommitted,
  rejectWithLadder,
} from './check-in-out.rejections';
import { CheckInOutDto } from './dto/check-in-out.dto';
import { autoCancelLeaveForCheckIn } from './check-in-out.leave';

/**
 * Check-in/out (16-1/16-2): one pg transaction per call (the 15-7 pattern
 * — zero new SQL functions, AD-3 amendment), AD-5 lock order (shared
 * tenant → exclusive employee), AD-6 row-level idempotency, AD-15
 * attempts-table rate limit, AD-13 same-transaction fake-location alert.
 * The server makes every decision; device values are inputs, never
 * verdicts. Rejections are PART of the committed outcome (AD-4: the
 * attempt row must survive), so the transaction RETURNS the mapped
 * exception and `run` throws it only AFTER the COMMIT — throwing inside
 * `withTransaction` would roll the attempt back (the real-DB journey
 * caught exactly this).
 */
@Injectable()
export class CheckInOutService {
  private readonly logger = new Logger(CheckInOutService.name);

  constructor(private readonly pg: PgPoolFactory) {}

  checkIn(
    user: RequestUser,
    dto: CheckInOutDto,
    requestId: string,
  ): Promise<CheckInResponse> {
    return this.run(
      user,
      dto,
      requestId,
      'check_in',
    ) as Promise<CheckInResponse>;
  }

  checkOut(
    user: RequestUser,
    dto: CheckInOutDto,
    requestId: string,
  ): Promise<CheckOutResponse> {
    return this.run(
      user,
      dto,
      requestId,
      'check_out',
    ) as Promise<CheckOutResponse>;
  }

  private async run(
    user: RequestUser,
    dto: CheckInOutDto,
    requestId: string,
    kind: AttemptKind,
  ): Promise<CheckInResponse | CheckOutResponse> {
    const tenantId = requireTenant(user);
    // Contract failures (office pin missing, read-backs empty) still throw
    // from inside — they abort the transaction, exactly as a 500 should.
    const outcome = await this.pg.withTransaction((tx) =>
      this.transact(tx, user, dto, requestId, kind, tenantId),
    );
    if (outcome.rejection) {
      throw outcome.rejection;
    }
    return outcome.response as CheckInResponse | CheckOutResponse;
  }

  private async transact(
    tx: PoolClient,
    user: RequestUser,
    dto: CheckInOutDto,
    requestId: string,
    kind: AttemptKind,
    tenantId: string,
  ): Promise<{
    response?: CheckInResponse | CheckOutResponse;
    rejection?: unknown;
  }> {
    await lockTenantShared(tx, tenantId);
    await lockEmployee(tx, user.userId);
    const today = await tenantToday(tx, tenantId);

    // AD-6: a replayed key answers exactly what the first call answered.
    const replay = await findAttemptByIdempotencyKey(
      tx,
      tenantId,
      user.userId,
      requestId,
    );
    if (replay) {
      return replayResponse(tx, replay, user.userId, tenantId, kind);
    }

    // AD-15: an active block records (not counts) and answers 429. The
    // day context is not read here — the block needs nothing from it.
    const blockedUntil = await readActiveBlockedUntil(tx, user.userId);
    if (blockedUntil) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((blockedUntil.getTime() - Date.now()) / 1000),
      );
      const attemptId = await insertAttempt(tx, {
        tenantId,
        employeeId: user.userId,
        requestId,
        kind,
        outcome: 'rate_limited',
        location: toAttemptLocation(dto, null),
        blockedUntil: null,
      });
      if (attemptId === null) {
        // The key raced another employee's insert — no second row.
        return { rejection: duplicateKeyRejection(kind) };
      }
      return {
        rejection: outcomeToException('rate_limited', kind, {
          officeName: null,
          retryAfterSeconds,
        }),
      };
    }

    // D1 day context. hasCheckIn=true implements D10 — FR-2 carves the
    // check-in itself out of the enable-day grace.
    const ctx = await buildDayContext(tx, tenantId, user.userId, today, true);

    const reject = (outcome: string, officeName: string | null) =>
      rejectCommitted(tx, user.userId, tenantId, requestId, kind, {
        outcome,
        location: toAttemptLocation(dto, ctx.radiusM),
        officeName,
      });

    if (!ctx.tracked) {
      return { rejection: await reject('not_tracked', ctx.officeName) };
    }

    // Kind-state conflicts (committed outcomes, never counted).
    const record = await findRecordByEmployeeDate(tx, user.userId, today);
    if (kind === 'check_in' && record) {
      return { rejection: await reject('already_checked_in', ctx.officeName) };
    }
    if (kind === 'check_out' && !record) {
      return { rejection: await reject('not_checked_in', ctx.officeName) };
    }
    if (kind === 'check_out' && record && record.checkout_at) {
      return { rejection: await reject('already_checked_out', ctx.officeName) };
    }

    // FR-9 (spec-17 D11): a full-day active leave on a working day needs
    // the employee's explicit confirmation before this check-in cancels
    // it — check-out is never gated. Not counted toward the rate limit.
    const leaveGateActive =
      kind === 'check_in' &&
      ctx.leaveState !== null &&
      ctx.leavePart === 'full_day' &&
      ctx.isWorkingDay;
    if (leaveGateActive && !dto.confirmLeaveCancel) {
      return {
        rejection: await reject('leave_confirmation_required', ctx.officeName),
      };
    }

    // Tracked days have exactly one covering assignment (the coverage
    // trigger); a missing pin means that contract broke — fail loud.
    if (
      ctx.officeId === null ||
      ctx.officeLat === null ||
      ctx.officeLng === null ||
      ctx.radiusM === null
    ) {
      this.logger.error('Tracked day without an office pin', {
        tenantId,
        employeeId: user.userId,
        workDate: today,
      });
      throw internalError('Failed to resolve the office for check-in');
    }

    const distanceM = haversineDistanceM(
      ctx.officeLat,
      ctx.officeLng,
      dto.latitude,
      dto.longitude,
    );
    const location = toAttemptLocation(dto, ctx.radiusM, distanceM);

    // D3 rejection ladder — exactly one outcome wins.
    let rejection: string | null = null;
    if (dto.fixAgeMs > FIX_MAX_AGE_MS) rejection = 'stale_fix';
    else if (dto.accuracyM > CHECKIN_MAX_ACCURACY_M) rejection = 'low_accuracy';
    else if (distanceM > ctx.radiusM) rejection = 'too_far';
    else if (dto.mocked === true) rejection = 'mocked';

    if (rejection) {
      return {
        rejection: await rejectWithLadder(tx, {
          tenantId,
          employeeId: user.userId,
          requestId,
          kind,
          rejection,
          ctx,
          location,
        }),
      };
    }

    // Accepted: the attempt row, then the record write, then re-read the
    // row so the response reflects the STORED instants (server now()).
    const attemptId = await insertAttempt(tx, {
      tenantId,
      employeeId: user.userId,
      requestId,
      kind,
      outcome: 'ok',
      location,
      blockedUntil: null,
    });
    if (attemptId === null) {
      // Lost a cross-employee key race — the other transaction owns the
      // key; answer 409 without a second row (spec D15).
      return { rejection: duplicateKeyRejection(kind) };
    }
    if (kind === 'check_in') {
      await insertRecord(tx, {
        tenantId,
        employeeId: user.userId,
        workDate: today,
        officeId: ctx.officeId,
        officeRulesId: ctx.officeRulesId,
        radiusM: ctx.radiusM,
        attemptId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracyM: dto.accuracyM,
        distanceM,
        mocked: dto.mocked === true,
        provider: location.provider,
      });
      // FR-9 accepted path (spec-17 D11): the ladder passed, so the
      // confirmed cancellation may proceed — ONLY today's leave date.
      if (leaveGateActive) {
        await autoCancelLeaveForCheckIn(tx, {
          tenantId,
          employeeId: user.userId,
          workDate: today,
        });
      }
    } else {
      await updateRecordCheckout(tx, {
        recordId: (record as RecordRow).id,
        attemptId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracyM: dto.accuracyM,
        distanceM,
        mocked: dto.mocked === true,
        provider: location.provider,
      });
    }
    const stored = await findRecordByEmployeeDate(tx, user.userId, today);
    if (!stored) {
      this.logger.error('Record missing after a committed write', {
        employeeId: user.userId,
        workDate: today,
      });
      throw internalError('Failed to read back the attendance record');
    }
    return {
      response: recordToResponse(
        stored,
        kind,
        ctx.timezone,
        toFlags(ctx),
        metricsFor(ctx, kind, stored),
      ),
    };
  }
}
