#!/usr/bin/env node
/**
 * Mock Microsoft Entra ID (v2.0 endpoints) for local demos and e2e tests.
 *
 *   npm run mock-idp
 *
 * Implements the parts of Entra that an OAuth 2.0 authorization-code + PKCE
 * client touches: tenant-specific discovery, /authorize (auto-approves a fixed
 * user), /token (single-use codes, exact redirect_uri match, PKCE S256,
 * client_secret_post or client_secret_basic), RS256 id_tokens with a `kid`,
 * JWKS, userinfo and logout. Test-only endpoints:
 *
 *   GET  /__log      requests seen by /authorize and /token (secrets redacted)
 *   GET  /__config   current behavior; POST /__config merges JSON into it
 *   POST /__reset    restore default behavior, clear log and codes
 *
 * Behavior keys for POST /__config:
 *   user            { oid, name, preferred_username, email, ppid, windowsaccountname }
 *                   signed-in user; the id_token carries ppid, nameid (= email),
 *                   windowsaccountname and email
 *   omitEmail       true -> id_token has no `email` claim (nameid still carries it)
 *   omitPpid        true -> id_token has no `ppid` claim (the app must reject it)
 *   claimStyle      "short" (ppid, nameid, ...) or "uri" (full ClaimType URIs)
 *   authorizeError  e.g. "access_denied" -> /authorize redirects with that error
 *   clientSecret    secret the token endpoint expects (simulate a wrong secret)
 *   tamperState     true -> /authorize returns a modified `state`
 */
import crypto from "node:crypto";
import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const HOST = process.env.MOCK_IDP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MOCK_IDP_PORT ?? 4011);
const TENANT = process.env.MOCK_IDP_TENANT_ID ?? "11111111-2222-3333-4444-555555555555";
const CLIENT_ID = process.env.MOCK_IDP_CLIENT_ID ?? "00000000-0000-0000-0000-000000000001";
const CLIENT_SECRET = process.env.MOCK_IDP_CLIENT_SECRET ?? "mock-client-secret";

const ORIGIN = `http://${HOST}:${PORT}`;
const ISSUER = `${ORIGIN}/${TENANT}/v2.0`;
const PATHS = {
  discovery: `/${TENANT}/v2.0/.well-known/openid-configuration`,
  authorize: `/${TENANT}/oauth2/v2.0/authorize`,
  token: `/${TENANT}/oauth2/v2.0/token`,
  keys: `/${TENANT}/discovery/v2.0/keys`,
  logout: `/${TENANT}/oauth2/v2.0/logout`,
  userinfo: "/oidc/userinfo",
};
const CODE_TTL_MS = 10 * 60 * 1000;
const KID = "mock-key-1";

const DEFAULTS = Object.freeze({
  user: {
    oid: "9f8e7d6c-5b4a-3210-fedc-ba9876543210",
    name: "Ada Lovelace",
    preferred_username: "ada@contoso.example",
    email: "ada@contoso.example",
    ppid: "10203040",
    windowsaccountname: "ada.love",
  },
  omitEmail: false,
  omitPpid: false,
  claimStyle: "short",
  authorizeError: null,
  clientSecret: CLIENT_SECRET,
  tamperState: false,
});

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" }] };

let config = structuredClone(DEFAULTS);
let log = [];
const codes = new Map(); // code -> authorize request + user snapshot
const accessTokens = new Map(); // access_token -> user
const refreshTokens = new Map(); // refresh_token -> { user, clientId, scope }

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string";
  res.writeHead(status, {
    "content-type": isJson ? "application/json" : "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body, null, 2) : body);
}

function redirect(res, location) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

function aadError(res, status, error, aadsts, description) {
  send(res, status, {
    error,
    error_description: `AADSTS${aadsts}: ${description}`,
    error_codes: [aadsts],
    timestamp: new Date().toISOString(),
    trace_id: crypto.randomUUID(),
    correlation_id: crypto.randomUUID(),
  });
}

function errorPage(res, message) {
  send(res, 400, `<!doctype html><title>Mock Entra ID</title><h1>Sign-in error</h1><p>${escapeHtml(message)}</p>`);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function redact(params) {
  const copy = { ...params };
  for (const key of ["client_secret", "code_verifier", "refresh_token"]) {
    if (copy[key]) copy[key] = "***";
  }
  return copy;
}

function record(endpoint, params, outcome) {
  log.push({ at: new Date().toISOString(), endpoint, params: redact(params), outcome });
  const extra = params.redirect_uri ? ` redirect_uri=${params.redirect_uri}` : "";
  console.log(`[mock-idp] ${endpoint} -> ${outcome}${extra}`);
}

/** Client credentials from HTTP Basic (RFC 6749 2.3.1, form-url-encoded) or the body. */
function clientCredentials(req, body) {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    return {
      method: "basic",
      id: decodeURIComponent(decoded.slice(0, i)),
      secret: decodeURIComponent(decoded.slice(i + 1)),
    };
  }
  return { method: "post", id: body.client_id, secret: body.client_secret };
}

// Entra's `sub` is pairwise: stable per user *and* application.
function pairwiseSub(user, clientId) {
  return crypto.createHash("sha256").update(`${user.oid}:${clientId}`).digest("base64url").slice(0, 43);
}

// The university claims, under their JWT short names or their full ClaimType URIs.
const CLAIM_NAMES = {
  short: { ppid: "ppid", nameId: "nameid", username: "windowsaccountname", email: "email" },
  uri: {
    ppid: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/ppid",
    nameId: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
    username: "http://schemas.microsoft.com/ws/2008/06/identity/claims/windowsaccountname",
    email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  },
};

async function issueTokens({ user, clientId, scope, nonce }) {
  const names = CLAIM_NAMES[config.claimStyle] ?? CLAIM_NAMES.short;
  const claims = {
    ver: "2.0",
    tid: TENANT,
    oid: user.oid,
    name: user.name,
    preferred_username: user.preferred_username,
    ...(config.omitPpid ? {} : { [names.ppid]: user.ppid }),
    [names.nameId]: user.email,
    [names.username]: user.windowsaccountname,
    ...(config.omitEmail || !user.email ? {} : { [names.email]: user.email }),
    ...(nonce ? { nonce } : {}),
    aio: crypto.randomBytes(16).toString("base64url"),
    uti: crypto.randomBytes(12).toString("base64url"),
  };
  const idToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(clientId)
    .setSubject(pairwiseSub(user, clientId))
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("1h")
    .sign(privateKey);

  const accessToken = crypto.randomBytes(32).toString("base64url");
  accessTokens.set(accessToken, user);
  const response = { token_type: "Bearer", scope, expires_in: 3599, ext_expires_in: 3599, access_token: accessToken, id_token: idToken };
  if (scope.split(" ").includes("offline_access")) {
    const refreshToken = crypto.randomBytes(32).toString("base64url");
    refreshTokens.set(refreshToken, { user, clientId, scope });
    response.refresh_token = refreshToken;
  }
  return response;
}

// ---------- endpoints ----------

function discovery(res) {
  send(res, 200, {
    issuer: ISSUER,
    authorization_endpoint: ORIGIN + PATHS.authorize,
    token_endpoint: ORIGIN + PATHS.token,
    jwks_uri: ORIGIN + PATHS.keys,
    userinfo_endpoint: ORIGIN + PATHS.userinfo,
    end_session_endpoint: ORIGIN + PATHS.logout,
    response_types_supported: ["code", "id_token", "code id_token", "id_token token"],
    response_modes_supported: ["query", "fragment", "form_post"],
    subject_types_supported: ["pairwise"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "private_key_jwt", "client_secret_basic"],
    code_challenge_methods_supported: ["plain", "S256"],
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "nbf", "nonce", "name", "preferred_username", "email", "oid", "tid", "ver", "ppid", "nameid", "windowsaccountname"],
    tenant_region_scope: "EU",
    cloud_instance_name: "mock.microsoftonline.example",
  });
}

function authorize(res, url) {
  const p = Object.fromEntries(url.searchParams);
  // Like Entra: problems with the client or redirect_uri show an error page,
  // because redirecting to an unverified redirect_uri would be unsafe.
  if (p.client_id !== CLIENT_ID) {
    record("authorize", p, "invalid client_id");
    return errorPage(res, `AADSTS700016: Application with identifier '${p.client_id}' was not found in the directory.`);
  }
  if (!p.redirect_uri) {
    record("authorize", p, "missing redirect_uri");
    return errorPage(res, "AADSTS900144: The request body must contain the following parameter: 'redirect_uri'.");
  }

  const back = new URL(p.redirect_uri);
  const state = config.tamperState && p.state ? `${p.state}tampered` : p.state;
  if (state) back.searchParams.set("state", state);
  const fail = (error, description, outcome) => {
    record("authorize", p, outcome);
    back.searchParams.set("error", error);
    back.searchParams.set("error_description", description);
    return redirect(res, back.href);
  };

  if (p.response_type !== "code") return fail("unsupported_response_type", "AADSTS70005: response_type must be 'code'.", "bad response_type");
  if (!p.scope?.split(" ").includes("openid")) return fail("invalid_scope", "AADSTS70011: The 'openid' scope is required.", "missing openid scope");
  if (!p.code_challenge || p.code_challenge_method !== "S256") {
    return fail("invalid_request", "AADSTS501491: PKCE with code_challenge_method=S256 is required by this mock.", "missing PKCE S256");
  }
  if (config.authorizeError) {
    return fail(config.authorizeError, "AADSTS65004: User declined to consent to access the app.", `error=${config.authorizeError}`);
  }

  const code = crypto.randomBytes(32).toString("base64url");
  codes.set(code, { ...p, user: structuredClone(config.user), expiresAt: Date.now() + CODE_TTL_MS });
  record("authorize", p, "code issued");
  back.searchParams.set("code", code);
  back.searchParams.set("session_state", crypto.randomUUID());
  redirect(res, back.href);
}

async function token(req, res) {
  const body = Object.fromEntries(new URLSearchParams(await readBody(req)));
  const client = clientCredentials(req, body);
  const params = { ...body, client_auth: client.method };
  const reject = (status, error, aadsts, description) => {
    record("token", params, `${error}: ${description}`);
    return aadError(res, status, error, aadsts, description);
  };

  if (client.id !== CLIENT_ID || client.secret !== config.clientSecret) {
    return reject(401, "invalid_client", 7000215, "Invalid client secret provided.");
  }

  if (body.grant_type === "refresh_token") {
    const entry = refreshTokens.get(body.refresh_token);
    if (!entry || entry.clientId !== client.id) return reject(400, "invalid_grant", 9002313, "Invalid refresh token.");
    refreshTokens.delete(body.refresh_token);
    record("token", params, "tokens refreshed");
    return send(res, 200, await issueTokens(entry));
  }
  if (body.grant_type !== "authorization_code") {
    return reject(400, "unsupported_grant_type", 70003, `Unsupported grant type '${body.grant_type}'.`);
  }

  const grant = codes.get(body.code);
  codes.delete(body.code); // single use, even when the request below fails
  if (!grant) return reject(400, "invalid_grant", 54005, "OAuth2 Authorization code was already redeemed or is unknown.");
  if (grant.expiresAt < Date.now()) return reject(400, "invalid_grant", 70008, "The provided authorization code has expired.");
  if (grant.client_id !== client.id) return reject(400, "invalid_grant", 70002, "The code was issued to a different client.");
  if (grant.redirect_uri !== body.redirect_uri) {
    return reject(400, "invalid_grant", 500112, `The reply address '${body.redirect_uri}' does not match '${grant.redirect_uri}'.`);
  }
  const challenge = crypto.createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
  if (challenge !== grant.code_challenge) return reject(400, "invalid_grant", 501481, "The Code_Verifier does not match the code_challenge.");

  record("token", params, "tokens issued");
  send(res, 200, await issueTokens({ user: grant.user, clientId: client.id, scope: grant.scope, nonce: grant.nonce }));
}

function userinfo(req, res) {
  const user = accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  if (!user) return send(res, 401, { error: "invalid_token" });
  send(res, 200, {
    sub: pairwiseSub(user, CLIENT_ID),
    name: user.name,
    ...(config.omitEmail || !user.email ? {} : { email: user.email }),
  });
}

function logout(res, url) {
  const target = url.searchParams.get("post_logout_redirect_uri");
  if (target) return redirect(res, target);
  send(res, 200, "<!doctype html><title>Mock Entra ID</title><h1>You signed out of your account</h1>");
}

async function testConfig(req, res) {
  if (req.method === "POST") {
    const patch = JSON.parse((await readBody(req)) || "{}");
    config = { ...config, ...patch, user: { ...config.user, ...patch.user } };
    console.log("[mock-idp] config updated", JSON.stringify(patch));
  }
  send(res, 200, config);
}

function reset(res) {
  config = structuredClone(DEFAULTS);
  log = [];
  codes.clear();
  send(res, 200, { ok: true });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);
  try {
    switch (url.pathname) {
      case PATHS.discovery: return discovery(res);
      case PATHS.keys: return send(res, 200, jwks);
      case PATHS.authorize: return authorize(res, url);
      case PATHS.token: return req.method === "POST" ? await token(req, res) : send(res, 405, { error: "method_not_allowed" });
      case PATHS.userinfo: return userinfo(req, res);
      case PATHS.logout: return logout(res, url);
      case "/__log": return send(res, 200, log);
      case "/__config": return await testConfig(req, res);
      case "/__reset": return reset(res);
      default: return send(res, 404, { error: "not_found", path: url.pathname });
    }
  } catch (err) {
    console.error("[mock-idp] error", err);
    send(res, 500, { error: "server_error", message: String(err) });
  }
});

server.on("error", (err) => {
  console.error(`[mock-idp] cannot listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-idp] Mock Entra ID listening on ${ORIGIN}`);
  console.log(`[mock-idp]   ENTRA_DISCOVERY_URL=${ORIGIN + PATHS.discovery}`);
  console.log(`[mock-idp]   ENTRA_CLIENT_ID=${CLIENT_ID}`);
  console.log(`[mock-idp]   ENTRA_CLIENT_SECRET=${CLIENT_SECRET}`);
  console.log(`[mock-idp]   signs in as ${config.user.name} <${config.user.preferred_username}> (auto-approve)`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(0));
}
