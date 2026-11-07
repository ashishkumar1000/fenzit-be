import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';

/**
 * Counts characters the way a person and the database do: Unicode code points.
 * JavaScript .length counts an emoji (outside the BMP) as two units, so a
 * 120-emoji name would be refused by MaxLength(120) even though it is 120
 * characters on screen.
 */
export const codePointCount = (text: string): number => [...text].length;

/**
 * Same contract as class-validator's MaxLength (string only, same default
 * message) but counted in code points. Use it wherever a field's limit is a
 * number of characters, so the import and manual create agree.
 */
export function MaxCodePoints(
  max: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'maxCodePoints',
      target: target.constructor,
      propertyName: propertyName as string,
      constraints: [max],
      options: {
        message:
          '$property must be shorter than or equal to $constraint1 characters',
        ...validationOptions,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') return false;
          return codePointCount(value) <= (args.constraints[0] as number);
        },
      },
    });
  };
}
