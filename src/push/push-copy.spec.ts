import { JOB_ASSIGNED_EVENT } from '../jobs/job-notifications';
import { PUSH_CHANNEL, pushCopyForEvent } from './push-copy';

describe('pushCopyForEvent', () => {
  describe('known events from the UX table', () => {
    it('job.assigned: jobs channel, public, job number and customer in the body', () => {
      const copy = pushCopyForEvent(JOB_ASSIGNED_EVENT, {
        job_number: 'JB-2026-0002',
        customer_name: 'Asha',
        scheduled_start: '2026-11-07T10:04:49+00:00',
      });
      expect(copy.title).toBe('New job assigned');
      expect(copy.body).toContain('JB-2026-0002');
      expect(copy.body).toContain('Asha');
      expect(copy.channel).toBe(PUSH_CHANNEL.jobs);
      expect(copy.visibility).toBe('PUBLIC');
    });

    it('report_ready: reports channel and private (report names stay off the lock screen)', () => {
      const copy = pushCopyForEvent('report_ready', {});
      expect(copy.channel).toBe(PUSH_CHANNEL.reports);
      expect(copy.visibility).toBe('PRIVATE');
    });

    it('a known event with an empty payload still returns a non-empty title', () => {
      expect(pushCopyForEvent(JOB_ASSIGNED_EVENT, {}).title.length).toBeGreaterThan(0);
    });

    it('truncates an over-long customer name in the body with an ellipsis', () => {
      const long = 'A'.repeat(200);
      const copy = pushCopyForEvent(JOB_ASSIGNED_EVENT, {
        job_number: 'JB-1',
        customer_name: long,
      });
      expect(copy.body).not.toContain(long);
      expect(copy.body).toContain('…');
    });

    it('a non-text customer name is ignored instead of rendered', () => {
      const copy = pushCopyForEvent(JOB_ASSIGNED_EVENT, {
        job_number: 'JB-1',
        customer_name: { evil: true },
      });
      expect(copy.body).not.toContain('evil');
      expect(copy.body).not.toContain('[object Object]');
    });
  });

  describe('job step notice for the owner (plain sentences, no step numbers)', () => {
    const full = {
      job_number: 'JB-2026-0010',
      technician_name: 'Ravi Kumar',
      step: 'on_my_way',
    };

    it('leads with the job number and says the person is on the way', () => {
      const copy = pushCopyForEvent('on_my_way', full);
      expect(copy.title).toBe('JB-2026-0010');
      expect(copy.body).toBe('Ravi Kumar is on the way');
      expect(copy.channel).toBe(PUSH_CHANNEL.jobs);
      expect(copy.visibility).toBe('PUBLIC');
    });

    it.each([
      ['arrived', 'Ravi Kumar has arrived at the site'],
      ['in_progress', 'Ravi Kumar has started the work'],
      ['photos_uploaded', 'Ravi Kumar has uploaded the photos'],
      ['signature_captured', 'Ravi Kumar has collected the customer signature'],
      ['completed', 'Ravi Kumar has completed the job'],
    ])('step %s reads as a sentence', (step, expected) => {
      expect(pushCopyForEvent(step, { ...full, step }).body).toBe(expected);
    });

    it('never shows a step number or a raw key in the body', () => {
      for (const step of ['on_my_way', 'arrived', 'in_progress', 'completed']) {
        const body = pushCopyForEvent(step, { ...full, step }).body;
        expect(body).not.toMatch(/step\s*\d/i);
        expect(body).not.toContain('_');
      }
    });

    it('a tenant-defined step key gets the generic plain line, not its raw key', () => {
      expect(
        pushCopyForEvent('inspect_meter', { ...full, step: 'inspect_meter' }).body,
      ).toBe('Ravi Kumar updated the job');
    });

    it('without a technician name, the sentence still reads naturally', () => {
      const copy = pushCopyForEvent('on_my_way', { job_number: 'JB-9', step: 'on_my_way' });
      expect(copy.title).toBe('JB-9');
      expect(copy.body).toBe('The technician is on the way');
    });

    it('with no job number and no payload, it is an unknown row: humanised title, title-only', () => {
      const copy = pushCopyForEvent('on_my_way', {});
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body).toBe('');
    });

    it('adds the customer name to the title when the row carries one', () => {
      const copy = pushCopyForEvent('on_my_way', {
        ...full,
        customer_name: 'Asha Traders',
      });
      expect(copy.title).toBe('JB-2026-0010 · Asha Traders');
      expect(copy.body).toBe('Ravi Kumar is on the way');
    });

    it('keeps the job number alone when there is no customer name', () => {
      expect(pushCopyForEvent('on_my_way', full).title).toBe('JB-2026-0010');
    });

    it('truncates a long customer name in the title', () => {
      const title = pushCopyForEvent('on_my_way', {
        ...full,
        customer_name: 'C'.repeat(80),
      }).title;
      expect(title).toContain('…');
      expect(title.length).toBeLessThan(45);
    });

    it('truncates an over-long technician name in the sentence', () => {
      const body = pushCopyForEvent('on_my_way', {
        ...full,
        technician_name: 'R'.repeat(100),
      }).body;
      expect(body).toContain('…');
      expect(body.length).toBeLessThan(60);
    });
  });

  describe('prototype keys never resolve to Object.prototype', () => {
    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
      '%s falls back to a plain card instead of returning a function as the title',
      (eventType) => {
        const copy = pushCopyForEvent(eventType, {});
        expect(typeof copy.title).toBe('string');
        expect(copy.title.length).toBeGreaterThan(0);
        expect(typeof copy.body).toBe('string');
      },
    );
  });

  describe('families without a table entry', () => {
    it('an unknown attendance subtype: humanised title, empty body, attendance channel, no visibility', () => {
      const copy = pushCopyForEvent('attendance.something_new', {
        message: 'raw prose must not leak',
      });
      expect(copy.channel).toBe(PUSH_CHANNEL.attendance);
      expect(copy.body).toBe('');
      expect(copy.visibility).toBeUndefined();
      expect(copy.title).not.toContain('raw prose');
    });

    it('a leave subtype with no table entry is title-only on the attendance channel', () => {
      const copy = pushCopyForEvent('leave.brand_new', {});
      expect(copy.channel).toBe(PUSH_CHANNEL.attendance);
      expect(copy.body).toBe('');
    });

    it('a job step event with a job number leads with the job number on the jobs channel', () => {
      const copy = pushCopyForEvent('step_key_x', {
        job_number: 'JB-7',
        technician_name: 'Ravi',
        step: 'arrived',
      });
      expect(copy.title).toBe('JB-7');
      expect(copy.body).toBe('Ravi has arrived at the site');
      expect(copy.channel).toBe(PUSH_CHANNEL.jobs);
      expect(copy.visibility).toBe('PUBLIC');
    });

    it('a job step with no technician name reads "The technician" and keeps the job number title', () => {
      const copy = pushCopyForEvent('step_key_x', { job_number: 'JB-7' });
      expect(copy.title).toBe('JB-7');
      expect(copy.body).toBe('The technician updated the job');
    });

    it.each(['   ', ''])(
      'a blank technician name (%j) reads as no name, not as an empty gap',
      (name) => {
        const copy = pushCopyForEvent('arrived', {
          job_number: 'JB-7',
          technician_name: name,
          step: 'arrived',
        });
        expect(copy.body).toBe('The technician has arrived at the site');
      },
    );

    it('trims padding around a technician name before it is shown', () => {
      const copy = pushCopyForEvent('arrived', {
        job_number: 'JB-7',
        technician_name: '  Ravi  ',
        step: 'arrived',
      });
      expect(copy.body).toBe('Ravi has arrived at the site');
    });

    it('an unknown type uses the payload title and message when given', () => {
      expect(
        pushCopyForEvent('future.thing', { title: 'Heads up', message: 'Read me' }),
      ).toMatchObject({ title: 'Heads up', body: 'Read me' });
    });

    it('an unknown type with no payload gets a humanised title and no channel', () => {
      const copy = pushCopyForEvent('future.thing', {});
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body).toBe('');
      expect(copy.channel).toBeUndefined();
      expect(copy.visibility).toBeUndefined();
    });
  });
});
