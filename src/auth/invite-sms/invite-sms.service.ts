import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../../common/factories/supabase-client.factory';
import {
  SmsDeliveryError,
  SmsDeliveryProvider,
} from '../sms-delivery.provider';
import {
  INVITE_SMS_DOWNLOAD_URL,
  INVITE_TEMPLATE_PLACEHOLDER,
  SMS_TEMPLATES,
} from '../../common/constants/sms-templates';
import {
  canonicalSubscriberNumber,
  fitCompanyName,
  fitFirstName,
  maskPhone,
} from './invite-sms-text';
import {
  INVITE_SMS_CAP_PER_PHONE,
  INVITE_SMS_CAP_WINDOW_MINUTES,
} from './invite-sms-cap.constants';

/**
 * `refused_cap`: the per-phone cap stopped the send, so nothing was sent
 * (story 21-2, decision 2026-11-11). Resend turns it into a 429.
 */
export type InviteSmsStatus =
  | 'sent'
  | 'failed'
  | 'not_configured'
  | 'refused_cap'
  | 'skipped_active';
type AuditOutcome = InviteSmsStatus;

export interface InviteSmsRequest {
  tenantId: string;
  /** user_id of the invited membership, as returned by invite_member. */
  membershipUserId: string;
  countryCode: string;
  phoneNumber: string;
  name: string;
}

/**
 * Sends the invite SMS after invite_member has saved the invite (CAP-1, CAP-6).
 * Never throws: an SMS problem is a status value, and the invite is kept.
 */
@Injectable()
export class InviteSmsService {
  private readonly logger = new Logger(InviteSmsService.name);

  constructor(
    private readonly smsDeliveryProvider: SmsDeliveryProvider,
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Sends one invite SMS, counted against the per-phone cap (CAP-2). Used by
   * the invite path and by the resend endpoint, so both share one cap.
   */
  async sendInviteSms(input: InviteSmsRequest): Promise<InviteSmsStatus> {
    // One canonical number for the mask, the cap hash and the send. Without
    // this, "09876543210" and "9876543210" count as two people (cap bypass).
    const req: InviteSmsRequest = {
      ...input,
      phoneNumber: canonicalSubscriberNumber(input.countryCode, input.phoneNumber),
    };
    const admin = this.supabaseClientFactory.createAdmin();
    const masked = maskPhone(req.countryCode, req.phoneNumber);

    // Placeholder template: sending is off. No provider call, no counter row.
    // The cast keeps this a runtime gate for any future template whose ID has
    // not been supplied yet; with T-INVITE approved it never fires.
    if ((SMS_TEMPLATES['T-INVITE'] as string) === INVITE_TEMPLATE_PLACEHOLDER) {
      await this.writeAudit(admin, req, masked, 'not_configured');
      return 'not_configured';
    }

    const e164 = `${req.countryCode}${req.phoneNumber}`;
    // Set once the cap slot is reserved. Only then is there a row to release.
    let counterId: string | null = null;
    try {
      // Only a still-pending invite gets a text (owner requirement
      // 2026-11-17). The DB refuses an invite to anyone already in the
      // company and the resend endpoint refuses a non-pending status, but
      // both checks run earlier in the request; a person who activates while
      // it runs would still be texted. This is the last line. A check and an
      // external send can never be one atomic step, so the residual window
      // is the gap between this select and the provider call. A DB error
      // reading the status throws into the catch below, which returns
      // 'failed' and audits it: no SMS goes out without its guard.
      const { data: pending, error: pendingError } = await admin
        .from('memberships')
        .select('status')
        .eq('user_id', req.membershipUserId)
        .eq('tenant_id', req.tenantId)
        .maybeSingle<{ status: string }>();
      if (pendingError) {
        throw new Error('Invite SMS status guard failed');
      }
      if (pending?.status !== 'invited') {
        await this.writeAudit(admin, req, masked, 'skipped_active');
        return 'skipped_active';
      }
      // The hash is made before the reservation. A missing key then stops the
      // SMS, so no message goes out without its counter row.
      const phoneHash = this.phoneHash(e164);
      const company = await this.companyName(admin, req.tenantId);
      // The count and the reservation are one database step, before the send
      // (story 21-2 race rule). A DB error here throws, so the SMS does not go.
      counterId = await this.reserveCounter(admin, phoneHash);
      if (counterId === null) {
        await this.writeAudit(admin, req, masked, 'refused_cap');
        return 'refused_cap';
      }
      await this.smsDeliveryProvider.send(e164, SMS_TEMPLATES['T-INVITE'], {
        employee: fitFirstName(req.name),
        company: fitCompanyName(company),
        url: INVITE_SMS_DOWNLOAD_URL,
      });
    } catch (err: unknown) {
      // Log the outcome only. Never the number or the message text.
      const reason =
        err instanceof SmsDeliveryError
          ? `${err.outcome}, vendor type ${err.vendorType ?? 'none'}`
          : `unexpected ${err instanceof Error ? err.name : 'error'}`;
      // A vendor rejection or timeout is a normal delivery outcome (warn). Any
      // other error is a fault in our own code or config, such as a missing
      // INVITE_SMS_HASH_KEY, so it is logged as an error to stand out.
      if (err instanceof SmsDeliveryError) {
        this.logger.warn(`Invite SMS not sent to ${masked}: ${reason}`);
      } else {
        this.logger.error(`Invite SMS not sent to ${masked}: ${reason}`);
      }
      // A failed send does not count toward the cap (owner decision 2026-11-10),
      // except a timeout: the SMS may have been delivered, so its slot stays
      // used (owner decision 2026-11-11).
      const timedOut =
        err instanceof SmsDeliveryError && err.outcome === 'timeout';
      if (counterId !== null && !timedOut) {
        await this.releaseCounter(admin, counterId);
      }
      await this.writeAudit(admin, req, masked, 'failed');
      return 'failed';
    }

    await this.writeAudit(admin, req, masked, 'sent');
    return 'sent';
  }

  /** HMAC-SHA256 of the E.164 number. The key lives in backend secrets only. */
  private phoneHash(e164: string): string {
    const key = this.configService.getOrThrow<string>('INVITE_SMS_HASH_KEY');
    return createHmac('sha256', key).update(e164).digest('hex');
  }

  /** The company name comes from the caller's own tenant, never from the request body. */
  private async companyName(
    admin: SupabaseClient,
    tenantId: string,
  ): Promise<string> {
    const { data, error } = await admin
      .from('tenants')
      .select('company_name')
      .eq('id', tenantId)
      .single();
    const name = (data as { company_name?: unknown } | null)?.company_name;
    if (error || typeof name !== 'string') {
      throw new Error('Company name lookup failed');
    }
    return name;
  }

  /** A failed audit write is logged, not thrown: the invite and the SMS outcome stand. */
  private async writeAudit(
    admin: SupabaseClient,
    req: InviteSmsRequest,
    maskedPhone: string,
    outcome: AuditOutcome,
  ): Promise<void> {
    // Never throws: a failed audit write must not turn a delivered invite into a 500.
    try {
      const { error } = await admin.from('invite_sms_audit').insert({
        membership_user_id: req.membershipUserId,
        tenant_id: req.tenantId,
        phone_masked: maskedPhone,
        outcome,
      });
      if (error) {
        this.logger.error(`Invite SMS audit row not written (${outcome})`);
      }
    } catch {
      this.logger.error(`Invite SMS audit row not written (${outcome}): write threw`);
    }
  }

  /**
   * Counts this phone's sends in the window and, below the cap, reserves one
   * slot in the same database transaction. Returns the counter row id, or null
   * when the cap is reached. Throws on a database error (the caller then does
   * not send).
   */
  private async reserveCounter(
    admin: SupabaseClient,
    phoneHash: string,
  ): Promise<string | null> {
    const { data, error }: { data: unknown; error: unknown } = await admin.rpc(
      'invite_sms_reserve_send',
      {
        p_phone_hash: phoneHash,
        p_max: INVITE_SMS_CAP_PER_PHONE,
        p_window_minutes: INVITE_SMS_CAP_WINDOW_MINUTES,
      },
    );
    if (error) {
      throw new Error('Invite SMS cap check failed');
    }
    return typeof data === 'string' ? data : null;
  }

  /** Removes a reserved slot after a failed send, so the failure does not count. */
  private async releaseCounter(
    admin: SupabaseClient,
    counterId: string,
  ): Promise<void> {
    const { error } = await admin
      .from('invite_sms_counter')
      .delete()
      .eq('id', counterId);
    if (error) {
      // The slot stays counted until the hourly prune removes it. Logged only.
      this.logger.error(
        'Invite SMS counter slot not released after a failed send',
      );
    }
  }
}
