import { timingSafeEqual } from "node:crypto";

/**
 * Compares two UTF-8 strings in constant time when their byte lengths match.
 * Comparing byte lengths avoids timingSafeEqual throwing on unequal buffer sizes
 * (including strings with equal UTF-16 code units but different UTF-8 byte lengths).
 */
export function timingSafeEqualText(left: unknown, right: string | null | undefined): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
