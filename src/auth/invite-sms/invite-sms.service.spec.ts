import { Logger } from '@nestjs/common';
import { SmsDeliveryError } from '../sms-delivery.provider';
import { InviteSmsService, InviteSmsRequest } from './invite-sms.service';

// Use a real-looking template ID so the send path runs. The shipped value is
// still the placeholder, which turns sending off.
jest.mock('../../common/constants/sms-templates', () => {
  const actual = jest.requireActual<
    typeof import('../../common/constants/sms-templates')
  >('../../common/constants/sms-templates');
  return {
    ...actual,
    SMS_TEMPLATES: { ...actual.SMS_TEMPLATES, 'T-INVITE': 'DLT-TEST-ID' },
  };
});

const HASH_KEY = 'k'.repeat(40);
const REQUEST: InviteSmsRequest = {
  tenantId: 'tenant-1',
  membershipUserId: 'member-1',
  countryCode: '+91',
  phoneNumber: '9876543210',
  name: 'Ravi Kumar',
  role: 'employee' as InviteSmsRequest['role'],
};

interface Harness {
  service: InviteSmsService;
  send: jest.Mock;
  rpc: jest.Mock;
  auditInsert: jest.Mock;
  counterDeleteEq: jest.Mock;
}

/**
 * Builds the service with a fake admin client. `reserve` is what the cap
 * function returns: a counter id (slot taken), null (cap reached) or an error.
 */
function harness(opts: {
  reserve?: { data: unknown; error: unknown };
  send?: jest.Mock;
}): Harness {
  const send = opts.send ?? jest.fn().mockResolvedValue(undefined);
  const rpc = jest
    .fn()
    .mockResolvedValue(opts.reserve ?? { data: 'counter-1', error: null });
  const auditInsert = jest.fn().mockResolvedValue({ error: null });
  const counterDeleteEq = jest.fn().mockResolvedValue({ error: null });

  const admin = {
    rpc,
    from: jest.fn((table: string) => {
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
      if (table === 'invite_sms_audit') {
        return { insert: auditInsert };
      }
      if (table === 'invite_sms_counter') {
        return { delete: () => ({ eq: counterDeleteEq }) };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
  const factory = { createAdmin: jest.fn().mockReturnValue(admin) };
  const config = { getOrThrow: jest.fn().mockReturnValue(HASH_KEY) };

  const service = new InviteSmsService(
    { send } as never,
    factory as never,
    config as never,
  );
  return { service, send, rpc, auditInsert, counterDeleteEq };
}

describe('InviteSmsService.sendInviteSms', () => {
  // Decision 1 (2026-11-11): a provider timeout counts toward the cap.
  describe('provider timeout', () => {
    it('returns failed and keeps the counted slot', async () => {
      const send = jest
        .fn()
        .mockRejectedValue(new SmsDeliveryError('timed out', 'timeout'));
      const h = harness({ send });

      await expect(h.service.sendInviteSms(REQUEST)).resolves.toBe('failed');
      expect(h.rpc).toHaveBeenCalledTimes(1);
      expect(h.counterDeleteEq).not.toHaveBeenCalled();
    });

    it('writes one audit row with outcome failed', async () => {
      const send = jest
        .fn()
        .mockRejectedValue(new SmsDeliveryError('timed out', 'timeout'));
      const h = harness({ send });

      await h.service.sendInviteSms(REQUEST);
      expect(h.auditInsert).toHaveBeenCalledTimes(1);
      expect(h.auditInsert).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed' }),
      );
    });
  });

  // A provider rejection is not a timeout, so the slot is released. This pins
  // the boundary: only timeouts keep the slot.
  describe('provider rejection (not a timeout)', () => {
    it('returns failed and releases the counted slot', async () => {
      const send = jest
        .fn()
        .mockRejectedValue(new SmsDeliveryError('rejected', 'error'));
      const h = harness({ send });

      await expect(h.service.sendInviteSms(REQUEST)).resolves.toBe('failed');
      expect(h.counterDeleteEq).toHaveBeenCalledWith('id', 'counter-1');
    });
  });

  it('a successful send keeps the slot and returns sent', async () => {
    const h = harness({});

    await expect(h.service.sendInviteSms(REQUEST)).resolves.toBe('sent');
    expect(h.counterDeleteEq).not.toHaveBeenCalled();
    expect(h.auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'sent' }),
    );
  });

  // Decision 2 (2026-11-11): a capped send returns refused_cap, not failed.
  describe('cap reached', () => {
    it('returns refused_cap and sends nothing', async () => {
      const send = jest.fn();
      const h = harness({ send, reserve: { data: null, error: null } });

      await expect(h.service.sendInviteSms(REQUEST)).resolves.toBe(
        'refused_cap',
      );
      expect(send).not.toHaveBeenCalled();
    });

    it('writes an audit row with outcome refused_cap and no counter delete', async () => {
      const h = harness({ reserve: { data: null, error: null } });

      await h.service.sendInviteSms(REQUEST);
      expect(h.auditInsert).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'refused_cap' }),
      );
      expect(h.counterDeleteEq).not.toHaveBeenCalled();
    });
  });

  // A failed cap check must never let an SMS through.
  it('a database error in the cap check returns failed and sends nothing', async () => {
    const send = jest.fn();
    const h = harness({
      send,
      reserve: { data: null, error: { message: 'db down' } },
    });

    await expect(h.service.sendInviteSms(REQUEST)).resolves.toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect(h.auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' }),
    );
  });
});

// Cap bypass and audit safety (review 2026-11-11). Each typed spelling of one
// Indian number must share one cap slot, and a rejected audit write must not
// turn a sent text into a thrown error.
describe('InviteSmsService: one person, one cap slot', () => {
  const SPELLINGS = ['9876543210', '09876543210', '919876543210', '098765 43210'];

  it.each(SPELLINGS)('hashes %s to the same cap key as the plain number', async typed => {
    const plain = harness({});
    await plain.service.sendInviteSms(REQUEST);
    const h = harness({});
    await h.service.sendInviteSms({ ...REQUEST, phoneNumber: typed });
    expect(h.rpc.mock.calls[0][1].p_phone_hash).toBe(
      plain.rpc.mock.calls[0][1].p_phone_hash,
    );
  });

  it('sends the text to the canonical number, not the typed spelling', async () => {
    const h = harness({});
    await h.service.sendInviteSms({ ...REQUEST, phoneNumber: '09876543210' });
    expect(h.send).toHaveBeenCalledWith(
      '+919876543210',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('a different number still gets its own cap key', async () => {
    const a = harness({});
    await a.service.sendInviteSms(REQUEST);
    const b = harness({});
    await b.service.sendInviteSms({ ...REQUEST, phoneNumber: '9123456780' });
    expect(b.rpc.mock.calls[0][1].p_phone_hash).not.toBe(
      a.rpc.mock.calls[0][1].p_phone_hash,
    );
  });

  it('a rejected audit write after a sent text still returns sent', async () => {
    const h = harness({});
    h.auditInsert.mockRejectedValueOnce(new Error('network down'));
    await expect(h.service.sendInviteSms(REQUEST)).resolves.toBe('sent');
  });
});

// Story 21-2 gaps at service level (review 2026-11-11): the net cap slots a
// phone uses across a failed send and a retry, and that no full number leaks
// into the audit row or the logs. The window reset and the parallel race need
// a real database and are covered by the e2e suite, not here.
describe('InviteSmsService: failed sends, retries and masking', () => {
  const FULL = REQUEST.phoneNumber;

  /** Slots taken minus slots released: the number of cap rows that remain. */
  const netSlots = (h: Harness) =>
    h.rpc.mock.calls.length - h.counterDeleteEq.mock.calls.length;

  it('a failed send then a successful resend leaves one cap slot, not two', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new SmsDeliveryError('vendor said no', 'error'))
      .mockResolvedValueOnce(undefined);
    const h = harness({ send });

    await expect(h.service.sendInviteSms(REQUEST)).resolves.toBe('failed');
    await expect(h.service.sendInviteSms(REQUEST)).resolves.toBe('sent');

    expect(netSlots(h)).toBe(1);
    expect(h.auditInsert.mock.calls.map(c => c[0].outcome)).toEqual([
      'failed',
      'sent',
    ]);
  });

  it('a timeout keeps its slot, so a retry after a timeout counts two', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new SmsDeliveryError('timed out', 'timeout'))
      .mockResolvedValueOnce(undefined);
    const h = harness({ send });

    await h.service.sendInviteSms(REQUEST);
    await h.service.sendInviteSms(REQUEST);

    expect(netSlots(h)).toBe(2);
  });

  it('asks the cap function for the 5-per-60-minute limit, not a caller value', async () => {
    const h = harness({});
    await h.service.sendInviteSms(REQUEST);
    expect(h.rpc).toHaveBeenCalledWith(
      'invite_sms_reserve_send',
      expect.objectContaining({ p_max: 5, p_window_minutes: 60 }),
    );
  });

  it('writes the masked number to the audit row and never the full number', async () => {
    const h = harness({});
    await h.service.sendInviteSms(REQUEST);
    const row = h.auditInsert.mock.calls[0][0];
    expect(row.phone_masked).toBe('+91 ******3210');
    expect(JSON.stringify(row)).not.toContain(FULL);
  });

  it('logs a failed send with the masked number only', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const h = harness({
        send: jest.fn().mockRejectedValue(new SmsDeliveryError('nope', 'error')),
      });
      await h.service.sendInviteSms(REQUEST);
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(FULL);
    } finally {
      warn.mockRestore();
    }
  });
});
