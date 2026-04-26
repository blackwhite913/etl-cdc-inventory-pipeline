import { NextResponse } from "next/server";

/**
 * Validates `Authorization: Bearer <CRON_SECRET>` on a request.
 * Returns a 401 NextResponse if the check fails, or null if authorized.
 * Use as the first check in any protected API route handler.
 */
export function requireCronSecret(request: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[auth] CRON_SECRET is not set — rejecting request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
