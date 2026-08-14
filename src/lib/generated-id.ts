// New IDs deliberately avoid confusing characters. This validator also accepts
// the historical `O` variant so existing managed accounts can continue to log in.
const LEGACY_GENERATED_ID_PATTERN = /^@py[A-HJ-NOP-Z2-9]{6}$/i;

export function normalizeGeneratedId(value: string) {
  return value.trim().toLowerCase();
}

export function isValidGeneratedId(value: string) {
  return LEGACY_GENERATED_ID_PATTERN.test(normalizeGeneratedId(value));
}
