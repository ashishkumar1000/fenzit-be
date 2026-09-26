import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Cross-field mirrors of the DB CHECKs on attendance_office_rules
 * (end_time > start_time, half_day_hours < full_day_hours) so the
 * ValidationPipe rejects violating payloads with a 422 before the DB is
 * touched. Each skips when its partner field is absent — the update DTO
 * enforces the complete rules set in the service, and the create DTO
 * requires every field.
 */

/** 'HH:mm' strings order lexicographically within one day. */
@ValidatorConstraint({ name: 'officeEndTimeAfterStart', async: false })
export class OfficeEndTimeAfterStartConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as { startTime?: string; endTime?: string };
    if (!dto?.startTime || !dto?.endTime) {
      return true;
    }
    return dto.endTime > dto.startTime;
  }

  defaultMessage(): string {
    return 'endTime must be after startTime (same-day HH:mm)';
  }
}

@ValidatorConstraint({ name: 'officeHalfLessThanFull', async: false })
export class OfficeHalfLessThanFullConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as { fullDayHours?: number; halfDayHours?: number };
    if (dto?.fullDayHours === undefined || dto?.halfDayHours === undefined) {
      return true;
    }
    return dto.halfDayHours < dto.fullDayHours;
  }

  defaultMessage(): string {
    return 'halfDayHours must be less than fullDayHours';
  }
}
