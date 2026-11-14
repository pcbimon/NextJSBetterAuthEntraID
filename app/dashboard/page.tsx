import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PROVIDER_ID } from "@/lib/env";
import { SignOutButton } from "./sign-out-button";

export default async function DashboardPage() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/");

  const accounts = await auth.api.listUserAccounts({ headers: requestHeaders });
  const entra = accounts.find((account) => account.providerId === PROVIDER_ID);

  return (
    <>
      <h1>Dashboard</h1>
      <p>You are signed in with Microsoft Entra ID.</p>
      <dl>
        <dt>Name</dt>
        <dd data-testid="user-name">{session.user.name}</dd>
        <dt>Email</dt>
        <dd data-testid="user-email">{session.user.email}</dd>
        <dt>Entra object ID</dt>
        <dd data-testid="account-id">{entra?.accountId ?? "–"}</dd>
        <dt>Session expires</dt>
        <dd data-testid="session-expires">{session.session.expiresAt.toISOString()}</dd>
      </dl>
      <SignOutButton />
    </>
  );
}
