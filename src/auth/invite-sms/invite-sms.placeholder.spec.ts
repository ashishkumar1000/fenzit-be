import {
  INVITE_TEMPLATE_PLACEHOLDER,
  SMS_TEMPLATES,
} from '../../common/constants/sms-templates';
import { InviteSmsService, InviteSmsRequest } from './invite-sms.service';
import { Role } from '../../common/enums/role.enum';

// Story 21-2 rule 6: while T-INVITE is the placeholder, sending is off. No
// provider call and no cap row; the audit says not_configured. This file does
// NOT mock the template, so it runs against the shipped placeholder value.
// It is a separate file because the send-path spec mocks the template ID.
//
// GO-LIVE: this test fails on purpose once the approved DLT template ID is set
// in sms-templates.ts. When that happens, delete this file, or change it to
// assert that sending is on.

const REQUEST: InviteSmsRequest = {
  tenantId: 'tenant-1',
  membershipUserId: 'member-1',
  countryCode: '+91',
  phoneNumber: '9876543210',
  name: 'Ravi Kumar',
  role: Role.EMPLOYEE as InviteSmsRequest['role'],
};

describe('InviteSmsService while the DLT template is pending', () => {
  it('ships with the placeholder template ID, so this test is meaningful', () => {
    expect(SMS_TEMPLATES['T-INVITE']).toBe(INVITE_TEMPLATE_PLACEHOLDER);
  });

  it('returns not_configured, calls no provider, reserves no cap row', async () => {
    const send = jest.fn();
    const rpc = jest.fn();
    const auditInsert = jest.fn().mockResolvedValue({ error: null });
    const admin = {
      rpc,
      from: jest.fn((table: string) => {
        if (table === 'invite_sms_audit') return { insert: auditInsert };
        throw new Error(`unexpected table ${table}`);
      }),
    };
    const service = new InviteSmsService(
      { send } as never,
      { createAdmin: jest.fn().mockReturnValue(admin) } as never,
      { getOrThrow: jest.fn().mockReturnValue('k'.repeat(40)) } as never,
    );

    await expect(service.sendInviteSms(REQUEST)).resolves.toBe(
      'not_configured',
    );
    expect(send).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(auditInsert.mock.calls[0][0].outcome).toBe('not_configured');
  });
});
