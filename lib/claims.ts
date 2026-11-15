/**
 * Claims issued by the university identity provider:
 *
 *   ShortName           ClaimType (URI)                                                              Value
 *   ppid                http://schemas.xmlsoap.org/ws/2005/05/identity/claims/ppid                   HRI_ID (staff) / Student_ID (student)
 *   Name ID             http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier         email
 *   windowsaccountname  http://schemas.microsoft.com/ws/2008/06/identity/claims/windowsaccountname   name.sur (staff) / u69xxxxx, g69xxxxx (student)
 *   email               http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress           email
 *
 * Depending on how the provider serialises its tokens, a claim arrives in the
 * id_token under its short name (JWT style) or under the full ClaimType URI
 * (SAML / WS-Fed style). Both spellings are accepted, short name first.
 */

type Claims = Record<string, unknown>;

const CLAIM_NAMES = {
  ppid: ["ppid", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/ppid"],
  nameId: [
    "nameid",
    "Name ID",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
  ],
  username: [
    "windowsaccountname",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/windowsaccountname",
  ],
  email: ["email", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"],
  displayName: ["name"],
} as const;

/** First non-empty value among `names`; a multi-valued claim (array) yields its first entry. */
function pick(claims: Claims, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = claims[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value.trim()) return value.trim();
    // A numeric ID (e.g. a student number) is still an identifier.
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export interface PersonClaims {
  /** Stable person identifier: HRI_ID for staff, Student_ID for students. */
  ppid: string;
  /** name.sur for staff, u69xxxxx / g69xxxxx for students. */
  username?: string;
  email?: string;
  /** `name` claim when present, otherwise the best available label (never empty). */
  name: string;
}

/**
 * Reads the person from a verified id_token's claims. Returns null when `ppid`
 * is missing: it is the only identifier that is stable across both staff and
 * students, so guessing another one (e.g. `sub`) would give the same person a
 * different account later.
 */
export function readPersonClaims(claims: Claims): PersonClaims | null {
  const ppid = pick(claims, CLAIM_NAMES.ppid);
  if (!ppid) return null;

  const username = pick(claims, CLAIM_NAMES.username);
  // Name ID carries the email too, so it covers tokens that omit the `email` claim.
  const email = pick(claims, CLAIM_NAMES.email) ?? pick(claims, CLAIM_NAMES.nameId);
  const name = pick(claims, CLAIM_NAMES.displayName) ?? username ?? email ?? ppid;

  return { ppid, username, email, name };
}
