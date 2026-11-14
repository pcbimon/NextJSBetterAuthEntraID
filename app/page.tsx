import { headers } from "next/headers";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { SignInButton } from "./sign-in-button";
import { describeSignInError } from "./sign-in-errors";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const error = first(params.error);
  const description = first(params.error_description);
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <>
      <h1>Welcome</h1>
      <p>Sign in with your Microsoft work or school account.</p>
      {error && (
        <div className="error" role="alert" data-testid="sign-in-error">
          <strong>{describeSignInError(error)}</strong>
          <div>
            Error code: <code>{error}</code>
          </div>
          {description && <div>{description}</div>}
        </div>
      )}
      {session ? (
        <p>
          You are signed in as {session.user.email}. <Link href="/dashboard">Go to dashboard</Link>
        </p>
      ) : (
        <SignInButton />
      )}
    </>
  );
}
