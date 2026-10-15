import { Injectable, Logger } from '@nestjs/common';
import { SmsDeliveryProvider } from './sms-delivery.provider';

/**
 * Dev/test stand-in for the SMS channel. Logs the send instead of hitting a
 * gateway — no real SMS spend, and the log line remains the way to read a
 * code in any environment running this provider (the pre-SMS-cutover
 * production window included). Deliberately constructor-less: the registry
 * constructs every adapter with ConfigService, and a 0-arg constructor
 * slots into that shape without pretending to need what it ignores.
 */
@Injectable()
export class MockSmsDeliveryProvider extends SmsDeliveryProvider {
  private readonly logger = new Logger(MockSmsDeliveryProvider.name);

  async send(
    to: string,
    templateId: string,
    variables: Record<string, string>,
  ): Promise<void> {
    // Keep "Code:" greppable — internal testers read the code from the logs
    // wherever the mock is the active provider. The named slot wins so a
    // second template variable can never mislabel which value is the code.
    const code = variables['number'] ?? Object.values(variables)[0] ?? '(none)';
    this.logger.log(
      `[MOCK SMS] Phone: ${to}, Code: ${code} (template ${templateId}, variables ${JSON.stringify(variables)}, Valid for 5 minutes)`,
    );
  }
}
