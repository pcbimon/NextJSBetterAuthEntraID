import { getAuth } from "./auth";
import { AUTH_BASE_PATH, getEnv, PROVIDER_ID } from "./env";

/**
 * Pathname of ENTRA_REDIRECT_URI when it differs from Better Auth's own
 * callback path (/api/auth/callback/entra), otherwise null.
 */
export function customCallbackPath(): string | null {
  const env = getEnv();
  return env.hasCustomRedirectPath ? new URL(env.redirectUri).pathname : null;
}

/**
 * Hands a request that arrived on the custom callback path to Better Auth as if
 * it had hit /api/auth/callback/entra. Better Auth's router matches on the
 * request URL, so a Next.js rewrite does not work (the handler still sees the
 * original path and answers 404); constructing a new Request does. The returned
 * Response (302 + Set-Cookie for the session) is passed through untouched.
 */
export async function forwardToAuthCallback(req: Request): Promise<Response> {
  const { baseUrl } = getEnv();
  const target = new URL(
    `${AUTH_BASE_PATH}/callback/${PROVIDER_ID}${new URL(req.url).search}`,
    baseUrl,
  );
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const res = await getAuth().handler(
    new Request(target, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? req.body : undefined,
      // Required by Node's fetch implementation when streaming a request body.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit),
  );

  // Better Auth redirects to the relative callbackURL (e.g. "/dashboard").
  // Next.js rejects relative Location headers on responses returned from
  // proxy.ts ("Invalid URL"), so make it absolute. Set-Cookie headers survive
  // because Headers copies every entry.
  const location = res.headers.get("location");
  if (!location) return res;
  const headers = new Headers(res.headers);
  headers.set("location", new URL(location, baseUrl).href);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
