import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth/session";
import { getDashboardAuthConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  invalid: "Incorrect password.",
  rate_limited: "Too many failed attempts. Try again in 15 minutes.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNextPath(one(params.next));
  const cfg = getDashboardAuthConfig();
  if (cfg.mode === "disabled") redirect(next);
  const error = ERRORS[one(params.error) ?? ""];

  return (
    <main style={{ maxWidth: 360, margin: "15vh auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Growth Dashboard</h1>
      {cfg.mode === "misconfigured" ? (
        <p role="alert">Login is not configured: {cfg.reason}.</p>
      ) : (
        <form method="post" action="/api/auth/login" style={{ display: "grid", gap: 12 }}>
          <input type="hidden" name="next" value={next} />
          <label style={{ display: "grid", gap: 4 }}>
            Password
            <input type="password" name="password" autoComplete="current-password" required autoFocus style={{ padding: 8, fontSize: 16 }} />
          </label>
          {error ? (
            <p role="alert" style={{ color: "#b00020", margin: 0 }}>
              {error}
            </p>
          ) : null}
          <button type="submit" style={{ padding: 8, fontSize: 16 }}>
            Sign in
          </button>
        </form>
      )}
    </main>
  );
}
