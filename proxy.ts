import { NextResponse, type NextRequest } from "next/server";
import { customCallbackPath, forwardToAuthCallback } from "@/lib/callback-forward";

/**
 * Accepts the OAuth callback on whatever path ENTRA_REDIRECT_URI names (e.g.
 * /signin-oidc), so changing the redirect URI needs no code or file changes.
 * Proxy runs on the Node.js runtime in Next 16, so it can call Better Auth
 * (and SQLite) directly. Every other request passes through unchanged.
 */
export async function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === customCallbackPath()) {
    return forwardToAuthCallback(req);
  }
  return NextResponse.next();
}

export const config = {
  // The callback path is only known at runtime, so match everything except static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
