import { Injectable, Logger } from '@nestjs/common';
import { OtpDeliveryProvider } from './otp-delivery.provider';

@Injectable()
export class MockOtpDeliveryProvider extends OtpDeliveryProvider {
  private readonly logger = new Logger(MockOtpDeliveryProvider.name);

  async send(phone: string, otp: string): Promise<void> {
    this.logger.log(
      `[MOCK OTP] Phone: ${phone}, Code: ${otp} (Valid for 5 minutes)`,
    );
  }
}
