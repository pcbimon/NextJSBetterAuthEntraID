import { expect, test } from "@playwright/test";
import { customApp as app, idp, rowsForEmail, signIn, signOut, uniqueUser } from "./helpers";

// Second app instance started with ENTRA_REDIRECT_URI=<origin>/signin-oidc.
test.describe("custom callback path (ENTRA_REDIRECT_URI)", () => {
  test("sign-in completes via the custom path, sent in both requests", async ({ page }) => {
    await idp.reset();
    const user = uniqueUser();
    await idp.configure({ user });

    await signIn(page, app);
    await expect(page.getByTestId("user-email")).toHaveText(user.email);

    const log = await idp.log();
    const authorize = log.find((e) => e.endpoint === "authorize");
    const token = log.find((e) => e.endpoint === "token");
    expect(authorize?.params.redirect_uri).toBe(app.redirectUri);
    expect(token?.params.redirect_uri).toBe(app.redirectUri);
    expect(new URL(app.redirectUri).pathname).toBe("/signin-oidc");
    expect(token?.outcome).toBe("tokens issued");

    const rows = rowsForEmail(app, user.email);
    expect(rows.accounts).toEqual([expect.objectContaining({ providerId: "entra", accountId: user.oid })]);
    expect(rows.sessions).toHaveLength(1);

    await signOut(page, app);
    expect(rowsForEmail(app, user.email).sessions).toHaveLength(0);
  });
});
