/** Runs once when the Next.js server starts (not during `next build`). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getEnv } = await import("./lib/env");
  // Throws with the name of a missing/invalid variable, so misconfiguration
  // surfaces at startup instead of on the first sign-in.
  const env = getEnv();
  console.log(
    `[auth] Redirect URI in effect (register this in Entra ID): ${env.redirectUri}`,
  );
}
