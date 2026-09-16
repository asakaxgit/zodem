export class ZodemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A Zod construct the walker does not (yet) support. */
export class UnsupportedTypeError extends ZodemError {
  constructor(path: string, detail: string) {
    super(`Unsupported Zod construct at ${path}: ${detail}`);
  }
}

/** A field's `.meta({ field })` pin conflicts with the lockfile. */
export class PinnedNumberMismatchError extends ZodemError {
  constructor(messageName: string, fieldName: string, pinned: number, existing: number | "reserved") {
    super(
      existing === "reserved"
        ? `${messageName}.${fieldName} is pinned to field ${pinned}, but ${pinned} is reserved in the lockfile. Choose a different number or un-reserve it.`
        : `${messageName}.${fieldName} is pinned to field ${pinned}, but the lockfile already assigns it field ${existing}. Field numbers cannot change once assigned; remove the pin or fix the mismatch.`,
    );
  }
}

/** An existing field/enum-value changed to a wire-incompatible type. */
export class BreakingChangeError extends ZodemError {
  constructor(ownerName: string, memberName: string, fromType: string, toType: string) {
    super(
      `Breaking change at ${ownerName}.${memberName}: type changed from "${fromType}" to "${toType}", ` +
        `which is not wire-compatible. Remove the field (it becomes reserved) and add a new one instead, ` +
        `or re-run with --allow-breaking to force it.`,
    );
  }
}

/** The persisted lockfile failed structural validation. */
export class LockfileValidationError extends ZodemError {
  constructor(detail: string) {
    super(`Invalid lockfile: ${detail}. Resolve the conflict by hand, then re-run generate.`);
  }
}

/** Two messages/services/enums registered under the same full name. */
export class DuplicateRegistrationError extends ZodemError {
  constructor(fullName: string) {
    super(`"${fullName}" is already registered. Full names must be unique across the schema.`);
  }
}

/** A `zodem rename` command couldn't be applied to the lockfile as given. */
export class RenameError extends ZodemError {}
