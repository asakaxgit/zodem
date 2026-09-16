/** camelCase or PascalCase -> snake_case. "createdAt" -> "created_at", "HTTPServer" -> "http_server". */
export function camelToSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** snake_case, camelCase, or kebab-case -> PascalCase. "address" -> "Address", "user_id" -> "UserId". */
export function pascalCase(s: string): string {
  return s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/** Any case -> UPPER_SNAKE_CASE, for enum value names. */
export function upperSnake(s: string): string {
  return camelToSnake(s).toUpperCase();
}
