/**
 * All configuration comes from environment variables (see .env.example).
 * Validation is lazy: nothing here runs at import time, so `next build` works
 * without any variables set. The first request (or instrumentation.ts at
 * server start) triggers validation and fails with the offending variable name.
 */

export const PROVIDER_ID = "entra";
export const AUTH_BASE_PATH = "/api/auth";

export interface AppEnv {
  baseUrl: string;
  secret: string;
  databasePath: string;
  entra: {
    clientId: string;
    clientSecret: string;
    discoveryUrl: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    scopes: string[];
  };
  /** The redirect_uri sent to Entra (configured or Better Auth's default). */
  redirectUri: string;
  /** True when ENTRA_REDIRECT_URI points somewhere other than the default callback path. */
  hasCustomRedirectPath: boolean;
  rateLimitEnabled: boolean;
}

const DEFAULT_SCOPES = ["openid", "profile", "email", "offline_access"];

class EnvError extends Error {
  constructor(message: string) {
    super(`[config] ${message} (see .env.example)`);
    this.name = "EnvError";
  }
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new EnvError(`Missing required environment variable ${name}`);
  return value;
}

function url(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new EnvError(`${name} is not a valid absolute URL: "${value}"`);
  }
}

function load(): AppEnv {
  const base = url("BETTER_AUTH_URL", required("BETTER_AUTH_URL"));
  const baseUrl = base.origin;
  const secret = required("BETTER_AUTH_SECRET");
  if (secret.length < 32) {
    throw new EnvError("BETTER_AUTH_SECRET must be at least 32 characters long");
  }
  const databasePath = required("DATABASE_PATH");
  const clientId = required("ENTRA_CLIENT_ID");
  const clientSecret = required("ENTRA_CLIENT_SECRET");
  const discoveryUrl = url("ENTRA_DISCOVERY_URL", required("ENTRA_DISCOVERY_URL")).href;

  const authorizationUrl = optional("ENTRA_AUTHORIZATION_URL");
  const tokenUrl = optional("ENTRA_TOKEN_URL");
  if (authorizationUrl) url("ENTRA_AUTHORIZATION_URL", authorizationUrl);
  if (tokenUrl) url("ENTRA_TOKEN_URL", tokenUrl);

  const defaultRedirectUri = `${baseUrl}${AUTH_BASE_PATH}/callback/${PROVIDER_ID}`;
  const configuredRedirect = optional("ENTRA_REDIRECT_URI");
  let redirectUri = defaultRedirectUri;
  if (configuredRedirect) {
    const parsed = url("ENTRA_REDIRECT_URI", configuredRedirect);
    // The callback must land on this app so its state/PKCE cookies are sent along.
    if (parsed.origin !== baseUrl) {
      throw new EnvError(
        `ENTRA_REDIRECT_URI origin (${parsed.origin}) must match BETTER_AUTH_URL origin (${baseUrl})`,
      );
    }
    if (parsed.search || parsed.hash) {
      throw new EnvError("ENTRA_REDIRECT_URI must not contain a query string or fragment");
    }
    // Keep the exact string: Entra compares redirect_uri byte-for-byte.
    redirectUri = configuredRedirect;
  }

  const scopes = optional("ENTRA_SCOPES")?.split(/[\s,]+/).filter(Boolean) ?? DEFAULT_SCOPES;

  return {
    baseUrl,
    secret,
    databasePath,
    entra: { clientId, clientSecret, discoveryUrl, authorizationUrl, tokenUrl, scopes },
    redirectUri,
    hasCustomRedirectPath: new URL(redirectUri).pathname !== new URL(defaultRedirectUri).pathname,
    rateLimitEnabled: optional("AUTH_RATE_LIMIT") !== "off",
  };
}

let cached: AppEnv | undefined;

export function getEnv(): AppEnv {
  cached ??= load();
  return cached;
}
