import { expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { randomInt, randomUUID } from "node:crypto";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run the tests with: npm run test:e2e`);
  return value;
}

export const IDP_URL = requireEnv("E2E_IDP_URL");

export interface AppUnderTest {
  baseURL: string;
  dbPath: string;
  /** redirect_uri the app is expected to send to the IdP. */
  redirectUri: string;
}

export const defaultApp: AppUnderTest = {
  baseURL: requireEnv("E2E_DEFAULT_APP_URL"),
  dbPath: requireEnv("E2E_DEFAULT_DB"),
  redirectUri: `${requireEnv("E2E_DEFAULT_APP_URL")}/api/auth/callback/entra`,
};

export const customApp: AppUnderTest = {
  baseURL: requireEnv("E2E_CUSTOM_APP_URL"),
  dbPath: requireEnv("E2E_CUSTOM_DB"),
  redirectUri: requireEnv("E2E_CUSTOM_REDIRECT_URI"),
};

// ---------- mock IdP control ----------

export interface MockUser {
  oid: string;
  name: string;
  preferred_username: string;
  email: string;
  ppid: string;
  windowsaccountname: string;
}

export interface IdpLogEntry {
  endpoint: "authorize" | "token";
  params: Record<string, string>;
  outcome: string;
}

export const idp = {
  async reset() {
    await fetch(`${IDP_URL}/__reset`, { method: "POST" });
  },
  async configure(patch: Record<string, unknown>) {
    const res = await fetch(`${IDP_URL}/__config`, { method: "POST", body: JSON.stringify(patch) });
    expect(res.ok).toBe(true);
  },
  async log(): Promise<IdpLogEntry[]> {
    return (await fetch(`${IDP_URL}/__log`)).json();
  },
};

/** A fresh user per test keeps database assertions independent of test order. */
export function uniqueUser(): MockUser {
  const id = randomUUID();
  const handle = `user-${id.slice(0, 8)}`;
  return {
    oid: id,
    name: `Test ${handle}`,
    preferred_username: `${handle}@contoso.example`,
    email: `${handle}.mail@contoso.example`,
    ppid: String(randomInt(10_000_000, 100_000_000)),
    windowsaccountname: handle.replace("-", "."),
  };
}

// ---------- browser flows ----------

export async function startSignIn(page: Page, app: AppUnderTest) {
  await page.goto(`${app.baseURL}/`);
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
}

export async function signIn(page: Page, app: AppUnderTest) {
  await startSignIn(page, app);
  await page.waitForURL(`${app.baseURL}/dashboard`);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

export async function signOut(page: Page, app: AppUnderTest) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${app.baseURL}/`);
  await expect(page.getByRole("button", { name: "Sign in with Microsoft" })).toBeVisible();
}

// ---------- database inspection ----------

export interface Rows {
  users: { id: string; email: string; name: string; ppid: string | null; username: string | null }[];
  accounts: { id: string; userId: string; providerId: string; accountId: string }[];
  sessions: { id: string; userId: string }[];
}

/** All rows belonging to the user with this email, read straight from the SQLite file. */
export function rowsForEmail(app: AppUnderTest, email: string): Rows {
  const db = new Database(app.dbPath, { readonly: true, fileMustExist: true });
  try {
    const users = db
      .prepare(`SELECT id, email, name, ppid, username FROM "user" WHERE email = ?`)
      .all(email) as Rows["users"];
    const ids = users.map((u) => u.id);
    const placeholders = ids.map(() => "?").join(",") || "NULL";
    const accounts = db
      .prepare(`SELECT id, userId, providerId, accountId FROM "account" WHERE userId IN (${placeholders})`)
      .all(...ids) as Rows["accounts"];
    const sessions = db
      .prepare(`SELECT id, userId FROM "session" WHERE userId IN (${placeholders})`)
      .all(...ids) as Rows["sessions"];
    return { users, accounts, sessions };
  } finally {
    db.close();
  }
}

export function sessionCount(app: AppUnderTest): number {
  const db = new Database(app.dbPath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM "session"`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

export async function expectRedirectedHome(page: Page, app: AppUnderTest) {
  await page.goto(`${app.baseURL}/dashboard`);
  await expect(page).toHaveURL(`${app.baseURL}/`);
}
