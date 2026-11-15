import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SignOutButton } from "./sign-out-button";

export default async function DashboardPage() {
  // Read the headers first: it marks the page dynamic, so `auth` (which needs the
  // runtime environment) is not touched while `next build` prerenders.
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/");

  const { user } = session;

  return (
    <>
      <h1>Dashboard</h1>
      <p>You are signed in with Microsoft Entra ID.</p>
      <dl>
        <dt>Name</dt>
        <dd data-testid="user-name">{user.name}</dd>
        <dt>Email</dt>
        <dd data-testid="user-email">{user.email}</dd>
        <dt>PPID (HRI_ID / Student_ID)</dt>
        <dd data-testid="user-ppid">{user.ppid ?? "–"}</dd>
        <dt>Username</dt>
        <dd data-testid="user-username">{user.username ?? "–"}</dd>
        <dt>Session expires</dt>
        <dd data-testid="session-expires">{session.session.expiresAt.toISOString()}</dd>
      </dl>
      <SignOutButton />
    </>
  );
}
