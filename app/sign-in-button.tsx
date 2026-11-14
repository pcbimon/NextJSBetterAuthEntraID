"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignInButton() {
  const [pending, setPending] = useState(false);

  async function signIn() {
    setPending(true);
    const { error } = await authClient.signIn.social({
      provider: "entra",
      callbackURL: "/dashboard",
      errorCallbackURL: "/",
    });
    // On success the browser is already navigating to Entra ID.
    if (error) {
      setPending(false);
      const params = new URLSearchParams({ error: error.code ?? "sign_in_failed" });
      if (error.message) params.set("error_description", error.message);
      window.location.assign(`/?${params}`);
    }
  }

  return (
    <button type="button" onClick={signIn} disabled={pending}>
      {pending ? "Redirecting…" : "Sign in with Microsoft"}
    </button>
  );
}
