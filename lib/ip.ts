/**
 * Best-effort client IP extraction. Vercel sets `x-forwarded-for` with
 * the client IP as the first entry. Falls back to "unknown" during
 * local dev (no proxy headers), which means all dev requests share one
 * rate-limit bucket — acceptable for a portfolio project.
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
