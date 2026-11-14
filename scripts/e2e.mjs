#!/usr/bin/env node
/**
 * One-command end-to-end run (npm run test:e2e):
 *   fresh temp databases -> mock IdP -> migrations -> next build ->
 *   two `next start` instances (default and custom callback path) ->
 *   Playwright -> tear everything down. Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "node_modules", ".bin");
const TMP = mkdtempSync(path.join(tmpdir(), "entra-e2e-"));

const IDP_PORT = 4011;
const IDP_URL = `http://127.0.0.1:${IDP_PORT}`;
const TENANT = "11111111-2222-3333-4444-555555555555";
const DEFAULT_PORT = 3100;
const CUSTOM_PORT = 3101;
const DEFAULT_URL = `http://localhost:${DEFAULT_PORT}`;
const CUSTOM_URL = `http://localhost:${CUSTOM_PORT}`;
const CUSTOM_REDIRECT_URI = `${CUSTOM_URL}/signin-oidc`;

const children = [];

function log(message) {
  console.log(`\n[e2e] ${message}`);
}

/** Base env for the app: every variable set explicitly so a local .env cannot leak in. */
function appEnv(baseUrl, dbPath, redirectUri = "") {
  return {
    BETTER_AUTH_URL: baseUrl,
    BETTER_AUTH_SECRET: "e2e-only-secret-e2e-only-secret-e2e-only",
    DATABASE_PATH: dbPath,
    ENTRA_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
    ENTRA_CLIENT_SECRET: "mock-client-secret",
    ENTRA_DISCOVERY_URL: `${IDP_URL}/${TENANT}/v2.0/.well-known/openid-configuration`,
    ENTRA_REDIRECT_URI: redirectUri,
    ENTRA_AUTHORIZATION_URL: "",
    ENTRA_TOKEN_URL: "",
    ENTRA_SCOPES: "",
    AUTH_RATE_LIMIT: "off",
  };
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

function startBackground(name, command, args, env = {}) {
  const logFile = path.join(TMP, `${name}.log`);
  const out = openSync(logFile, "w");
  // detached: own process group, so teardown also kills grandchildren (next-server).
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...env },
  });
  children.push({ name, child, logFile });
  return child;
}

async function waitFor(url, name, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    if (children.find((c) => c.name === name)?.child.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not become ready at ${url}`);
}

function assertPortFree(port, host) {
  return new Promise((resolve, reject) => {
    const probe = createServer()
      .once("error", () => reject(new Error(`Port ${port} is in use (stop "npm run mock-idp"/"npm run dev" first)`)))
      .once("listening", () => probe.close(resolve))
      .listen(port, host);
  });
}

function teardown() {
  for (const { child } of children) {
    if (child.exitCode == null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

function dumpLogs() {
  for (const { name, logFile } of children) {
    const lines = readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-40);
    console.error(`\n----- last lines of ${name} log -----\n${lines.join("\n")}`);
  }
}

async function main() {
  for (const port of [IDP_PORT, DEFAULT_PORT, CUSTOM_PORT]) await assertPortFree(port, "0.0.0.0");

  const defaultDb = path.join(TMP, "default.db");
  const customDb = path.join(TMP, "custom.db");

  log(`Starting mock IdP on ${IDP_URL}`);
  startBackground("mock-idp", process.execPath, ["mock-idp/server.mjs"]);
  await waitFor(`${IDP_URL}/${TENANT}/v2.0/.well-known/openid-configuration`, "mock-idp");

  log("Migrating fresh databases");
  await run(path.join(BIN, "auth"), ["migrate", "--config", "lib/auth.ts", "--yes"], appEnv(DEFAULT_URL, defaultDb));
  await run(path.join(BIN, "auth"), ["migrate", "--config", "lib/auth.ts", "--yes"], appEnv(CUSTOM_URL, customDb));

  // Built without any auth variables on purpose: configuration is read at runtime only.
  log("Building the app (next build)");
  await run(path.join(BIN, "next"), ["build"]);

  log(`Starting app instances: ${DEFAULT_URL} (default callback), ${CUSTOM_URL} (callback ${CUSTOM_REDIRECT_URI})`);
  startBackground("app-default", path.join(BIN, "next"), ["start", "-p", String(DEFAULT_PORT)], appEnv(DEFAULT_URL, defaultDb));
  startBackground(
    "app-custom",
    path.join(BIN, "next"),
    ["start", "-p", String(CUSTOM_PORT)],
    appEnv(CUSTOM_URL, customDb, CUSTOM_REDIRECT_URI),
  );
  await waitFor(DEFAULT_URL, "app-default");
  await waitFor(CUSTOM_URL, "app-custom");

  log("Running Playwright");
  await run(path.join(BIN, "playwright"), ["test", ...process.argv.slice(2)], {
    E2E_IDP_URL: IDP_URL,
    E2E_DEFAULT_APP_URL: DEFAULT_URL,
    E2E_DEFAULT_DB: defaultDb,
    E2E_CUSTOM_APP_URL: CUSTOM_URL,
    E2E_CUSTOM_DB: customDb,
    E2E_CUSTOM_REDIRECT_URI: CUSTOM_REDIRECT_URI,
  });
}

let exitCode = 0;
process.on("SIGINT", () => {
  teardown();
  process.exit(130);
});
try {
  await main();
  log("All e2e tests passed");
} catch (err) {
  exitCode = 1;
  console.error(`\n[e2e] FAILED: ${err.message}`);
  dumpLogs();
} finally {
  teardown();
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(exitCode);
