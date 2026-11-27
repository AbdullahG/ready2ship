import { InvalidKeyError, MissingKeyError } from "@/lib/ai/errors";
import { DiveCancelledError } from "@/lib/dive/budget";

// 403 is retried: GitHub's secondary rate limit answers 403.
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 404, 410, 422]);

/**
 * Whether trying again later could succeed. A missing or rejected key needs a
 * human; GitHub 400/401/404/410/422 mean the request itself is wrong. Rate limits,
 * 5xx, network errors, quota and malformed model output may clear up.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof InvalidKeyError || err instanceof MissingKeyError || err instanceof DiveCancelledError) return false;
  const status = (err as { status?: number }).status;
  return !(typeof status === "number" && PERMANENT_HTTP_STATUSES.has(status));
}
