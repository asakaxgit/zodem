/** camelCase or PascalCase -> snake_case. "createdAt" -> "created_at", "HTTPServer" -> "http_server". */
export const camelToSnake = (s: string): string => {
  return s
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .toLowerCase();
};

/** snake_case, camelCase, or kebab-case -> PascalCase. "address" -> "Address", "user_id" -> "UserId". */
export const pascalCase = (s: string): string => {
  return s
    .split(/[_\s-]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
};

/** Any case -> UPPER_SNAKE_CASE, for enum value names. */
export const upperSnake = (s: string): string => {
  return camelToSnake(s).toUpperCase();
};
