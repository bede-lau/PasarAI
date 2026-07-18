export function createPersistentKey(...parts) {
  if (
    parts.length === 0
    || parts.some((part) =>
      part === null
      || part === undefined
      || String(part).length === 0
    )
  ) {
    throw new Error("Persistent key parts must be non-empty");
  }

  return JSON.stringify(parts.map(String));
}
