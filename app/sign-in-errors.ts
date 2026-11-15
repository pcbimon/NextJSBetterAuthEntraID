/** Human-readable text for the `error` codes Better Auth / Entra put on the error redirect. */
const MESSAGES: Record<string, string> = {
  access_denied: "Sign-in was cancelled or access was denied by Microsoft Entra ID.",
  invalid_code:
    "Microsoft Entra ID rejected the authorization code exchange. Check ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and the registered redirect URI.",
  state_mismatch: "The sign-in request could not be verified (state mismatch). Please try again.",
  state_not_found: "The sign-in request could not be verified (missing state). Please try again.",
  please_restart_the_process: "The sign-in request expired or was tampered with. Please try again.",
  unable_to_get_user_info:
    "The ID token from Microsoft Entra ID could not be verified or did not contain the ppid claim.",
  email_not_found: "Your account did not provide an email address (email or Name ID claim).",
  oauth_provider_not_found:
    "The Microsoft Entra ID provider is not available. Check ENTRA_DISCOVERY_URL and that the identity provider is reachable.",
};

export function describeSignInError(code: string): string {
  return MESSAGES[code] ?? "Sign-in failed. Please try again.";
}
