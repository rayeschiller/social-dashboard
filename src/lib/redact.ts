/**
 * Removes credentials from strings before they are logged or stored (error messages, URLs).
 * The client never puts tokens in URLs, but Graph API `paging.next` URLs and upstream error
 * text are not under our control, so everything that leaves the process goes through here.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/([?&](?:access_token|client_secret|code|input_token|refresh_token)=)[^&#\s"']+/gi, "$1[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
  [/("(?:access_token|client_secret|refresh_token)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2"],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Path + query of a URL with secrets removed, for storing in api_errors.endpoint. */
export function safeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    for (const key of ["access_token", "client_secret", "code"]) {
      if (u.searchParams.has(key)) u.searchParams.set(key, "[REDACTED]");
    }
    return redact(`${u.host}${u.pathname}${u.search}`);
  } catch {
    return redact(url);
  }
}
