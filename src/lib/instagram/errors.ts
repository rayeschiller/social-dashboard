import type { AvailabilityStatus } from "../provenance";
import { redact } from "../redact";

/**
 * How a failure should be treated. Graph API error codes:
 * https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes/
 * plus the generic Graph API codes (190 invalid token, 4/17/32/613 throttling, 10/200-299
 * permissions, 1/2 transient, 100 invalid parameter).
 */
export type ErrorClassification =
  | "auth" // token missing/invalid/expired (190, 102, HTTP 401)
  | "permission" // token valid but lacks a permission (10, 200-299, HTTP 403)
  | "unsupported_metric" // metric not offered for this object/product type
  | "insufficient_data" // e.g. "(#10) Not enough viewers for the media to show insights"
  | "not_found" // object does not exist or is not visible (100/33)
  | "rate_limit" // 4, 17, 32, 613, HTTP 429
  | "transient" // 1, 2, is_transient, HTTP 5xx
  | "network" // fetch failed / timed out
  | "invalid_request" // other 100s
  | "invalid_response" // the API answered 2xx with a body we cannot interpret
  | "unknown";

export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  fbtrace_id?: string;
  error_user_title?: string;
  error_user_msg?: string;
}

export class InstagramApiError extends Error {
  readonly classification: ErrorClassification;
  readonly httpStatus: number | null;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly type: string | null;
  readonly fbtraceId: string | null;
  /** Path + non-secret query. */
  readonly endpoint: string;
  attempts: number;

  constructor(args: {
    message: string;
    classification: ErrorClassification;
    endpoint: string;
    httpStatus?: number | null;
    code?: number | null;
    subcode?: number | null;
    type?: string | null;
    fbtraceId?: string | null;
    attempts?: number;
  }) {
    super(redact(args.message));
    this.name = "InstagramApiError";
    this.classification = args.classification;
    this.endpoint = args.endpoint;
    this.httpStatus = args.httpStatus ?? null;
    this.code = args.code ?? null;
    this.subcode = args.subcode ?? null;
    this.type = args.type ?? null;
    this.fbtraceId = args.fbtraceId ?? null;
    this.attempts = args.attempts ?? 1;
  }

  get retryable(): boolean {
    return (
      this.classification === "rate_limit" ||
      this.classification === "transient" ||
      this.classification === "network"
    );
  }

  /** Errors after which continuing the run is pointless (every further call would fail too). */
  get fatalForRun(): boolean {
    return this.classification === "auth" || this.classification === "permission" || this.classification === "rate_limit";
  }
}

/** Raised before any HTTP call when there is no credential to use. */
export class NoTokenError extends Error {
  constructor(message = "No Instagram access token is configured") {
    super(message);
    this.name = "NoTokenError";
  }
}

const UNSUPPORTED_PATTERNS = [
  /does not support/i,
  /not supported/i,
  /unsupported/i,
  /metric.*(?:is not|isn't) (?:available|valid)/i,
  /must be one of the following values/i,
  /invalid metric/i,
];

export function classifyGraphError(httpStatus: number | null, body: GraphErrorBody | undefined): ErrorClassification {
  const code = body?.code;
  const sub = body?.error_subcode;
  const msg = body?.message ?? "";

  if (code === 190 || code === 102 || code === 463 || code === 467) return "auth";
  if (code === 4 || code === 17 || code === 32 || code === 613 || httpStatus === 429) return "rate_limit";
  if (code === 10 && /not enough viewers/i.test(msg)) return "insufficient_data";
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) return "permission";
  if (code === 100 && sub === 33) return "not_found";
  if (code === 100 && UNSUPPORTED_PATTERNS.some((re) => re.test(msg))) return "unsupported_metric";
  if (code === 1 || code === 2 || body?.is_transient === true) return "transient";
  if (code === 100) return "invalid_request";
  if (httpStatus === 401) return "auth";
  if (httpStatus === 403) return "permission";
  if (httpStatus !== null && httpStatus >= 500) return "transient";
  if (httpStatus === 404) return "not_found";
  return "unknown";
}

/** Map an error classification onto the stored availability status of a metric. */
export function statusForClassification(c: ErrorClassification): AvailabilityStatus {
  switch (c) {
    case "unsupported_metric":
      return "unsupported";
    case "insufficient_data":
      return "unavailable";
    default:
      return "error";
  }
}
