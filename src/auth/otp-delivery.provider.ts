export abstract class OtpDeliveryProvider {
  abstract send(phone: string, otp: string): Promise<void>;
}
