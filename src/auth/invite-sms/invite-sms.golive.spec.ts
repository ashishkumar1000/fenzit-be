import {
  INVITE_SMS_DOWNLOAD_URL,
  INVITE_TEMPLATE_PLACEHOLDER,
  SMS_TEMPLATES,
} from '../../common/constants/sms-templates';
import { InviteSmsService, InviteSmsRequest } from './invite-sms.service';

// Go-live state (2026-11-17): T-INVITE holds the approved MSG91 panel ID, so
// sending is on. This file does NOT mock the template, so it runs against the
// shipped constants — it guards the flip and the fixed download URL. The
// send-path behaviour with a mocked template lives in invite-sms.service.spec.
//
// Until go-live this file asserted the placeholder (sending off). The
// requirement changed when the DLT template was approved, so the assertions
// flipped with it.

const REQUEST: InviteSmsRequest = {
  tenantId: 'tenant-1',
  membershipUserId: 'member-1',
  countryCode: '+91',
  phoneNumber: '9876543210',
  name: 'Ravi Kumar',
};

describe('InviteSmsService once the DLT template is approved', () => {
  it('ships the approved template ID, not the placeholder', () => {
    expect(SMS_TEMPLATES['T-INVITE']).not.toBe(INVITE_TEMPLATE_PLACEHOLDER);
    expect(SMS_TEMPLATES['T-INVITE']).toBe('6afb418448cacda45c094b32');
  });

  it('sends with the approved variable names and the one fixed download URL', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const rpc = jest.fn().mockResolvedValue({ data: 'counter-1', error: null });
    const auditInsert = jest.fn().mockResolvedValue({ error: null });
    const admin = {
      rpc,
      from: jest.fn((table: string) => {
        if (table === 'memberships') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { status: 'invited' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'tenants') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { company_name: 'Jobzo Services' },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'invite_sms_audit') return { insert: auditInsert };
        throw new Error(`unexpected table ${table}`);
      }),
    };
    const service = new InviteSmsService(
      { send },
      { createAdmin: jest.fn().mockReturnValue(admin) } as never,
      { getOrThrow: jest.fn().mockReturnValue('k'.repeat(40)) } as never,
    );

    await expect(service.sendInviteSms(REQUEST)).resolves.toBe('sent');
    expect(send).toHaveBeenCalledWith(
      '+919876543210',
      SMS_TEMPLATES['T-INVITE'],
      {
        employee: 'Ravi',
        company: 'Jobzo Services',
        url: INVITE_SMS_DOWNLOAD_URL,
      },
    );
    expect(auditInsert.mock.calls[0][0].outcome).toBe('sent');
    expect(INVITE_SMS_DOWNLOAD_URL).toBe('https://fenzit.com/app/download');
  });
});
