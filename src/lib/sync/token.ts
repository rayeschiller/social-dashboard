/**
 * Long-lived token refresh.
 * https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/
 * "Refresh a long-lived access token that is at least 24 hours old but has not expired.
 *  Refreshed tokens are valid for 60 days from the date at which they are refreshed."
 *
 * Only tokens stored by the OAuth flow (auth mode 'db') are refreshed here. In 'env' and 'proxy'
 * modes this app does not hold the credential, so the run is recorded as skipped.
 */
import { withTransaction } from "../db";
import { getInstagramConfig } from "../config";
import { InstagramClient } from "../instagram/client";
import { getPinnedAccountId, verifyClientAccount } from "../account/tracked";
import { getActiveToken, storeToken } from "../tokens/store";
import { audit, nowFn, runJob, SyncAbort, type SyncContext, type SyncRunResult } from "./runs";

const MIN_AGE_MS = 24 * 3600 * 1000;
/** Refresh once fewer than this many days remain (tokens last 60 days). */
export const REFRESH_WHEN_REMAINING_DAYS = 30;

export async function refreshTokenJob(
  ctx: SyncContext,
  opts: { fetchImpl?: typeof fetch; force?: boolean } = {},
): Promise<SyncRunResult> {
  const now = nowFn(ctx);
  return runJob(
    ctx,
    "token_refresh",
    async () => {
      const mode = ctx.client?.authMode ?? null;
      if (mode !== "db") {
        return {
          status: "skipped",
          note: {
            code: "not_applicable",
            message: `auth mode is ${mode ?? "none"}; only tokens stored by the OAuth flow are refreshed by this app`,
          },
        };
      }
      const pinned = await getPinnedAccountId(ctx.db);
      if (!pinned) throw new SyncAbort("no_account", "No tracked Instagram account is pinned yet");
      const token = await getActiveToken(ctx.db, pinned);
      if (!token) throw new SyncAbort("no_token", "no stored token to refresh");
      const t = now();
      const age = t.getTime() - token.issuedAt.getTime();
      if (token.expiresAt && token.expiresAt.getTime() <= t.getTime()) {
        throw new SyncAbort("token_expired", "stored token has expired; reconnect via /api/auth/instagram/start");
      }
      if (age < MIN_AGE_MS) {
        return { igUserId: token.igUserId, status: "skipped", note: { code: "too_new", message: "token is less than 24 hours old" } };
      }
      const remainingDays = token.expiresAt ? (token.expiresAt.getTime() - t.getTime()) / 86_400_000 : 0;
      if (!opts.force && token.expiresAt && remainingDays > REFRESH_WHEN_REMAINING_DAYS) {
        return {
          igUserId: token.igUserId,
          status: "skipped",
          stats: { remainingDays: Math.floor(remainingDays) },
          note: { code: "not_due", message: `token has ${Math.floor(remainingDays)} days left` },
        };
      }
      const cfg = getInstagramConfig();
      const refresher = new InstagramClient({
        accessToken: token.accessToken,
        authMode: "db",
        apiVersion: cfg.apiVersion,
        baseUrl: cfg.graphBaseUrl,
        fetchImpl: opts.fetchImpl,
      });
      // The stored token must still belong to the tracked account, and so must the refreshed one.
      await verifyClientAccount(ctx.db, refresher);
      const refreshed = await refresher.refreshLongLivedToken();
      await verifyClientAccount(
        ctx.db,
        new InstagramClient({
          accessToken: refreshed.accessToken,
          authMode: "db",
          apiVersion: cfg.apiVersion,
          baseUrl: cfg.graphBaseUrl,
          fetchImpl: opts.fetchImpl,
        }),
      );
      const issuedAt = now();
      const newId = await withTransaction(ctx.db, async (tx) => {
        const id = await storeToken(tx, {
          igUserId: token.igUserId,
          accessToken: refreshed.accessToken,
          scopes: token.scopes,
          issuedAt,
          expiresInSeconds: refreshed.expiresIn,
          obtainedVia: "refresh",
        });
        await audit(tx, "system", "token_refreshed", { type: "oauth_token", id: String(id) }, { previousTokenId: token.id });
        return id;
      });
      return { igUserId: token.igUserId, stats: { newTokenId: newId, expiresInSeconds: refreshed.expiresIn } };
    },
    { requiresClient: false },
  );
}
