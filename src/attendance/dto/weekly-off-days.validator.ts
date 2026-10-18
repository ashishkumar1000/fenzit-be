import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

/** ISO weekday numbers, 1 = Monday .. 7 = Sunday — the DB CHECK's vocabulary. */
export const WEEKLY_OFF_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

type DaysProblem = 'not-a-list' | 'bad-day' | 'duplicate' | null;

function daysProblem(value: unknown): DaysProblem {
  if (!Array.isArray(value)) return 'not-a-list';
  const allWeekdays = value.every((d) =>
    (WEEKLY_OFF_DAYS as readonly unknown[]).includes(d),
  );
  if (!allWeekdays) return 'bad-day';
  if (new Set(value).size !== value.length) return 'duplicate';
  return null;
}

/**
 * The weekly-off `days` list: a list of weekday numbers 1..7, each at most
 * once, empty allowed. One constraint instead of three stacked decorators so
 * a bad body yields exactly ONE plain message naming the real problem — the
 * stacked class-validator defaults produced misleading text such as
 * "All days's elements must be unique" for a body with no list at all (R-08).
 */
@ValidatorConstraint({ name: 'isWeeklyOffDays', async: false })
export class WeeklyOffDaysConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return daysProblem(value) === null;
  }

  defaultMessage(args?: ValidationArguments): string {
    switch (daysProblem(args?.value)) {
      case 'not-a-list':
        return 'Days must be a list of weekday numbers, for example [6, 7]';
      case 'bad-day':
        return 'Each day must be a whole number from 1 (Monday) to 7 (Sunday)';
      case 'duplicate':
        return 'Each day can be listed only once';
      default:
        return 'Days are not valid';
    }
  }
}
