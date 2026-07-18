const unsafePathCharacters = /[\\\u0000-\u001f\u007f]/u;

function hasUnsafeCharacters(value: string) {
  if (unsafePathCharacters.test(value)) return true;
  try {
    return unsafePathCharacters.test(decodeURIComponent(value));
  } catch {
    return true;
  }
}

export function safeInternalPath(value: unknown, baseUrl?: string) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    hasUnsafeCharacters(value)
  ) {
    return "/";
  }
  if (!baseUrl) return value;

  try {
    const base = new URL(baseUrl);
    const resolved = new URL(value, base);
    return resolved.origin === base.origin
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : "/";
  } catch {
    return "/";
  }
}
