import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins";
import Database from "better-sqlite3";
import { decodeJwt } from "jose";
import { AUTH_BASE_PATH, getEnv, PROVIDER_ID } from "./env";

function createAuth() {
  const env = getEnv();

  return betterAuth({
    baseURL: env.baseUrl,
    basePath: AUTH_BASE_PATH,
    secret: env.secret,
    database: new Database(env.databasePath),
    rateLimit: { enabled: env.rateLimitEnabled },
    // Failures before the sign-in state can be read (e.g. tampered state) go here.
    onAPIError: { errorURL: "/" },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: PROVIDER_ID,
            name: "Microsoft Entra ID",
            discoveryUrl: env.entra.discoveryUrl,
            // Never fall back to unverified id_token decoding if discovery is incomplete.
            requireIdTokenVerification: true,
            authorizationUrl: env.entra.authorizationUrl,
            tokenUrl: env.entra.tokenUrl,
            clientId: env.entra.clientId,
            clientSecret: env.entra.clientSecret,
            scopes: env.entra.scopes,
            pkce: true,
            // Sent as redirect_uri in both the authorize request and the token
            // exchange. A custom path is routed to Better Auth by proxy.ts.
            redirectURI: env.redirectUri,
            // Better Auth verifies the id_token (signature, issuer, audience, nonce)
            // before calling this, so decoding it here is safe. We build the profile
            // from the id_token instead of calling userinfo because Entra's userinfo
            // lives on Microsoft Graph and omits most claims; Entra also never sends
            // email_verified, and `email` is optional (absent for many accounts).
            getUserInfo: async (tokens) => {
              if (!tokens.idToken) return null;
              const claims = decodeJwt(tokens.idToken);
              if (typeof claims.oid !== "string") return null; // not an Entra ID token
              const email = claims.email ?? claims.preferred_username;
              return {
                ...claims,
                id: claims.oid,
                email: typeof email === "string" ? email : undefined,
                name: typeof claims.name === "string" ? claims.name : undefined,
                emailVerified: false,
              };
            },
            // `oid` is the user's immutable id across all apps in the tenant;
            // Entra's `sub` is pairwise per application.
            accountSubject: ({ profile }) => String(profile.oid),
            // Sign-out ends only the app session. Otherwise Better Auth would send
            // the browser to Entra's end_session_endpoint (global Microsoft logout).
            disableProviderLogout: true,
          },
        ],
      }),
      nextCookies(), // must stay last
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}

/**
 * Lazily constructed so that importing this module (during `next build`, or by
 * the Better Auth CLI) does not require the environment to be complete until
 * the instance is actually used.
 */
export const auth: Auth = new Proxy({} as Auth, {
  get: (_target, prop) => Reflect.get(getAuth(), prop),
  has: (_target, prop) => Reflect.has(getAuth(), prop),
  ownKeys: () => Reflect.ownKeys(getAuth()),
  getOwnPropertyDescriptor: (_target, prop) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(getAuth(), prop);
    // Proxy invariant: properties missing on the (empty) target must be configurable.
    return descriptor && { ...descriptor, configurable: true };
  },
});
