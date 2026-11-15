import { expect, test } from "@playwright/test";
import {
  defaultApp as app,
  expectRedirectedHome,
  idp,
  rowsForEmail,
  sessionCount,
  signIn,
  signOut,
  startSignIn,
  uniqueUser,
  type MockUser,
} from "./helpers";

test.describe("default callback path (/api/auth/callback/entra)", () => {
  let user: MockUser;

  test.beforeEach(async () => {
    await idp.reset();
    user = uniqueUser();
    await idp.configure({ user });
  });

  test("sign-in reaches the dashboard and uses the same redirect_uri in both requests", async ({ page }) => {
    await signIn(page, app);
    await expect(page.getByTestId("user-name")).toHaveText(user.name);
    await expect(page.getByTestId("user-email")).toHaveText(user.email);
    await expect(page.getByTestId("user-ppid")).toHaveText(user.ppid);
    await expect(page.getByTestId("user-username")).toHaveText(user.windowsaccountname);

    const log = await idp.log();
    const authorize = log.find((e) => e.endpoint === "authorize");
    const token = log.find((e) => e.endpoint === "token");
    expect(authorize?.outcome).toBe("code issued");
    expect(token?.outcome).toBe("tokens issued");
    expect(authorize?.params.redirect_uri).toBe(app.redirectUri);
    expect(token?.params.redirect_uri).toBe(authorize?.params.redirect_uri);
    expect(authorize?.params.redirect_uri).toMatch(/\/api\/auth\/callback\/entra$/);
    // Authorization code flow with PKCE S256.
    expect(authorize?.params.response_type).toBe("code");
    expect(authorize?.params.code_challenge_method).toBe("S256");
    expect(token?.params.code_verifier).toBe("***");
  });

  test("SQLite contains user, account and session rows after sign-in", async ({ page }) => {
    await signIn(page, app);
    const rows = rowsForEmail(app, user.email);
    expect(rows.users).toHaveLength(1);
    expect(rows.users[0].name).toBe(user.name);
    expect(rows.users[0].ppid).toBe(user.ppid);
    expect(rows.users[0].username).toBe(user.windowsaccountname);
    // The account is keyed by ppid, not by the IdP's per-app `sub` or `oid`.
    expect(rows.accounts).toEqual([
      expect.objectContaining({ userId: rows.users[0].id, providerId: "entra", accountId: user.ppid }),
    ]);
    expect(rows.sessions).toHaveLength(1);
  });

  test("session survives a page reload", async ({ page }) => {
    await signIn(page, app);
    await page.reload();
    await expect(page).toHaveURL(`${app.baseURL}/dashboard`);
    await expect(page.getByTestId("user-email")).toHaveText(user.email);
  });

  test("sign-out deletes the session and protects /dashboard again", async ({ page }) => {
    await signIn(page, app);
    expect(rowsForEmail(app, user.email).sessions).toHaveLength(1);
    await signOut(page, app);
    expect(rowsForEmail(app, user.email).sessions).toHaveLength(0);
    await expectRedirectedHome(page, app);
  });

  test("anonymous visitors are redirected from /dashboard to /", async ({ page }) => {
    await expectRedirectedHome(page, app);
    await expect(page.getByRole("button", { name: "Sign in with Microsoft" })).toBeVisible();
  });

  test("id_token without email falls back to the Name ID claim", async ({ page }) => {
    await idp.configure({ omitEmail: true });
    await signIn(page, app);
    await expect(page.getByTestId("user-email")).toHaveText(user.email);
    expect(rowsForEmail(app, user.email).users).toHaveLength(1);
  });

  test("claims sent under their full ClaimType URIs are read too", async ({ page }) => {
    await idp.configure({ claimStyle: "uri" });
    await signIn(page, app);
    await expect(page.getByTestId("user-ppid")).toHaveText(user.ppid);
    await expect(page.getByTestId("user-username")).toHaveText(user.windowsaccountname);
    await expect(page.getByTestId("user-email")).toHaveText(user.email);
  });

  test("id_token without ppid is rejected and creates no session", async ({ page }) => {
    await idp.configure({ omitPpid: true });
    const before = sessionCount(app);
    await startSignIn(page, app);
    await page.waitForURL(/\/\?error=/);
    await expect(page.getByTestId("sign-in-error")).toContainText("did not contain the ppid claim");
    expect(sessionCount(app)).toBe(before);
    expect(rowsForEmail(app, user.email).users).toHaveLength(0);
  });

  test("a signed-in user cannot overwrite their ppid through /update-user", async ({ page }) => {
    await signIn(page, app);
    // `origin` passes Better Auth's CSRF check, so a 404 proves the endpoint is off.
    const res = await page.request.post(`${app.baseURL}/api/auth/update-user`, {
      data: { ppid: "99999999", username: "someone.else" },
      headers: { origin: app.baseURL },
    });
    expect(res.status()).toBe(404);
    const [row] = rowsForEmail(app, user.email).users;
    expect(row.ppid).toBe(user.ppid);
    expect(row.username).toBe(user.windowsaccountname);
  });

  test("username and name are refreshed on the next sign-in", async ({ page }) => {
    await signIn(page, app);
    await signOut(page, app);
    const renamed = { ...user, name: `${user.name} Renamed`, windowsaccountname: `${user.windowsaccountname}.new` };
    await idp.configure({ user: renamed });
    await signIn(page, app);
    await expect(page.getByTestId("user-username")).toHaveText(renamed.windowsaccountname);
    const rows = rowsForEmail(app, user.email);
    expect(rows.users).toHaveLength(1);
    expect(rows.users[0].name).toBe(renamed.name);
    expect(rows.users[0].username).toBe(renamed.windowsaccountname);
    expect(rows.accounts).toHaveLength(1);
  });

  test("wrong client secret shows a readable error and creates no session", async ({ page }) => {
    await idp.configure({ clientSecret: "the-app-does-not-know-this-secret" });
    const before = sessionCount(app);
    await startSignIn(page, app);
    await page.waitForURL(/\/\?error=/);
    await expect(page.getByTestId("sign-in-error")).toContainText("rejected the authorization code exchange");
    const token = (await idp.log()).find((e) => e.endpoint === "token");
    expect(token?.outcome).toMatch(/^invalid_client/);
    expect(sessionCount(app)).toBe(before);
    expect(rowsForEmail(app, user.email).users).toHaveLength(0);
    await expectRedirectedHome(page, app);
  });

  test("IdP error=access_denied shows a readable error", async ({ page }) => {
    await idp.configure({ authorizeError: "access_denied" });
    const before = sessionCount(app);
    await startSignIn(page, app);
    await page.waitForURL(/\/\?error=access_denied/);
    await expect(page.getByTestId("sign-in-error")).toContainText("access was denied");
    expect((await idp.log()).some((e) => e.endpoint === "token")).toBe(false);
    expect(sessionCount(app)).toBe(before);
  });

  test("tampered state is rejected and creates no session", async ({ page }) => {
    await idp.configure({ tamperState: true });
    const before = sessionCount(app);
    await startSignIn(page, app);
    await page.waitForURL(/\/\?error=/);
    await expect(page.getByTestId("sign-in-error")).toContainText("could not be verified");
    // The app must stop before redeeming the code.
    expect((await idp.log()).some((e) => e.endpoint === "token")).toBe(false);
    expect(sessionCount(app)).toBe(before);
    await expectRedirectedHome(page, app);
  });

  test("a second sign-in reuses the same user and account rows", async ({ page }) => {
    await signIn(page, app);
    const first = rowsForEmail(app, user.email);
    await signOut(page, app);
    await signIn(page, app);
    const second = rowsForEmail(app, user.email);
    expect(second.users).toEqual(first.users);
    expect(second.users[0].ppid).toBe(user.ppid);
    expect(second.accounts.map((a) => a.id)).toEqual(first.accounts.map((a) => a.id));
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].id).not.toBe(first.sessions[0].id);
  });
});
