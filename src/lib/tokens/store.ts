import { getPinnedAccountId } from "../account/tracked";
import type { Queryable } from "../db";
import { decryptToken, encryptToken, parseEncryptionKey } from "./crypto";

export interface StoredToken {
  id: number;
  igUserId: string;
  accessToken: string;
  issuedAt: Date;
  expiresAt: Date | null;
  scopes: string[];
}

export interface StoreTokenInput {
  igUserId: string;
  accessToken: string;
  scopes: string[];
  issuedAt: Date;
  expiresInSeconds: number | null;
  obtainedVia: "oauth_callback" | "refresh";
}

/**
 * Stores a new encrypted token and marks earlier active tokens of the account as superseded.
 * Must be called inside a transaction (pass a PoolClient) so the swap is atomic.
 */
export async function storeToken(
  db: Queryable,
  input: StoreTokenInput,
  key: Buffer = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY),
): Promise<number> {
  const enc = encryptToken(input.accessToken, input.igUserId, key);
  const expiresAt =
    input.expiresInSeconds != null
      ? new Date(input.issuedAt.getTime() + input.expiresInSeconds * 1000)
      : null;
  await db.query(
    `UPDATE oauth_tokens SET superseded_at = $2
      WHERE ig_user_id = $1 AND superseded_at IS NULL AND revoked_at IS NULL`,
    [input.igUserId, input.issuedAt],
  );
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO oauth_tokens
       (ig_user_id, key_version, token_iv, token_ciphertext, token_auth_tag, scopes,
        obtained_via, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.igUserId,
      enc.keyVersion,
      enc.iv,
      enc.ciphertext,
      enc.authTag,
      input.scopes,
      input.obtainedVia,
      input.issuedAt,
      expiresAt,
    ],
  );
  return rows[0]!.id;
}

interface TokenRow {
  id: number;
  ig_user_id: string;
  key_version: number;
  token_iv: Buffer;
  token_ciphertext: Buffer;
  token_auth_tag: Buffer;
  issued_at: Date;
  expires_at: Date | null;
  scopes: string[];
}

/**
 * Newest non-superseded, non-revoked token of the TRACKED account, decrypted. `igUserId` defaults
 * to the pinned tracked account id (tracked_account); with nothing pinned there is no token.
 * Tokens of any other account are never returned implicitly.
 */
export async function getActiveToken(
  db: Queryable,
  igUserId?: string | null,
  key?: Buffer,
): Promise<StoredToken | null> {
  const trackedId = igUserId ?? (await getPinnedAccountId(db));
  if (!trackedId) return null;
  const { rows } = await db.query<TokenRow>(
    `SELECT id, ig_user_id, key_version, token_iv, token_ciphertext, token_auth_tag,
            issued_at, expires_at, scopes
       FROM oauth_tokens
      WHERE superseded_at IS NULL AND revoked_at IS NULL AND ig_user_id = $1
      ORDER BY issued_at DESC, id DESC
      LIMIT 1`,
    [trackedId],
  );
  const row = rows[0];
  if (!row) return null;
  const k = key ?? parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  const accessToken = decryptToken(
    {
      iv: row.token_iv,
      ciphertext: row.token_ciphertext,
      authTag: row.token_auth_tag,
      keyVersion: row.key_version,
    },
    row.ig_user_id,
    k,
  );
  return {
    id: row.id,
    igUserId: row.ig_user_id,
    accessToken,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    scopes: row.scopes,
  };
}
