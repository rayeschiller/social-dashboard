import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, parseEncryptionKey } from "../../src/lib/tokens/crypto";

const key = randomBytes(32);
const token = "SYNTHETIC-not-a-real-token-1234567890";

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips", () => {
    const enc = encryptToken(token, "acct-1", key);
    expect(decryptToken(enc, "acct-1", key)).toBe(token);
  });

  it("never contains the plaintext and uses a fresh IV each time", () => {
    const a = encryptToken(token, "acct-1", key);
    const b = encryptToken(token, "acct-1", key);
    expect(a.ciphertext.toString("utf8")).not.toContain(token);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("rejects a wrong key, a different account (AAD) and tampering", () => {
    const enc = encryptToken(token, "acct-1", key);
    expect(() => decryptToken(enc, "acct-1", randomBytes(32))).toThrow();
    expect(() => decryptToken(enc, "acct-2", key)).toThrow();
    const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 0xff;
    expect(() => decryptToken(tampered, "acct-1", key)).toThrow();
  });

  it("parses base64 and hex keys and rejects bad lengths", () => {
    expect(parseEncryptionKey(key.toString("base64")).equals(key)).toBe(true);
    expect(parseEncryptionKey(key.toString("hex")).equals(key)).toBe(true);
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseEncryptionKey(undefined)).toThrow(/not set/);
  });
});
