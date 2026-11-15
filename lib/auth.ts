import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins";
import Database from "better-sqlite3";
import { decodeJwt } from "jose";
import { readPersonClaims } from "./claims";
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
    user: {
      // Extra columns on `user`; `npm run db:migrate` adds them. They must NOT be
      // `input: false`: Better Auth then refuses to copy them from the provider
      // profile, so they would stay null.
      additionalFields: {
        ppid: { type: "string", required: false },
        username: { type: "string", required: false },
      },
    },
    // Fields without `input: false` are also writable through /update-user, which
    // would let a signed-in user overwrite their own ppid. This app never edits
    // profiles, so the endpoint is switched off; both fields then only ever come
    // from the verified id_token.
    disabledPaths: ["/update-user"],
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
            // before calling this, so decoding it here is safe. The profile is built
            // from the id_token instead of calling userinfo because the identity
            // provider puts ppid / windowsaccountname / email there (see lib/claims.ts).
            // The IdP sends no email_verified claim, so the email stays unverified.
            getUserInfo: async (tokens) => {
              if (!tokens.idToken) return null;
              const claims = decodeJwt(tokens.idToken);
              const person = readPersonClaims(claims);
              if (!person) return null; // no ppid: the person cannot be identified
              return {
                ...claims,
                id: person.ppid,
                email: person.email,
                name: person.name,
                emailVerified: false,
                ppid: person.ppid,
                username: person.username,
              };
            },
            // Stored in `user` (see additionalFields below). Refreshed on every
            // sign-in so a changed name.sur / email does not go stale.
            mapProfileToUser: (profile) => ({
              ppid: String(profile.ppid),
              username: typeof profile.username === "string" ? profile.username : undefined,
            }),
            overrideUserInfo: true,
            // `ppid` (HRI_ID for staff, Student_ID for students) is the person's
            // stable identifier. The default `sub` is pairwise per application.
            accountSubject: ({ profile }) => String(profile.ppid),
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
