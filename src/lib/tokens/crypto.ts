import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for OAuth tokens at rest.
 * Key: TOKEN_ENCRYPTION_KEY = 32 random bytes, base64 (or 64 hex chars).
 * The account id is bound as additional authenticated data, so a ciphertext copied onto another
 * account's row fails to decrypt.
 */

export const KEY_VERSION = 1;

export interface EncryptedToken {
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or hex)");
  }
  return key;
}

function aad(igUserId: string): Buffer {
  return Buffer.from(`oauth_tokens:v${KEY_VERSION}:${igUserId}`, "utf8");
}

export function encryptToken(plaintext: string, igUserId: string, key: Buffer): EncryptedToken {
  if (!plaintext) throw new Error("refusing to encrypt an empty token");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(igUserId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag(), keyVersion: KEY_VERSION };
}

export function decryptToken(enc: EncryptedToken, igUserId: string, key: Buffer): string {
  if (enc.keyVersion !== KEY_VERSION) throw new Error(`unknown token key version ${enc.keyVersion}`);
  const decipher = createDecipheriv("aes-256-gcm", key, enc.iv);
  decipher.setAAD(aad(igUserId));
  decipher.setAuthTag(enc.authTag);
  return Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]).toString("utf8");
}
