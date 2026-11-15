import { timingSafeEqual } from "node:crypto";

/** Constant-time check of "Authorization: Bearer <secret>". False if the secret is unset. */
export function hasBearerSecret(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(authorization);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
