// A release that stops declaring every token role refuses them at once: crud
// is told the roles the program declares (PGRST_APP_SETTINGS_TOKEN_ROLES),
// and the floor admits a registered role only while it is told it. The
// database keeps the role registered and granted, though, until a migrate
// step runs the `roles` reconcile's prune, which an app with no other runs
// only where it says `tokenRoles: {}`: generation warns, by the roles its last
// generation's facts recorded.

type Facts = { declaredRoles?: string[]; prunesTokenRoles?: boolean } | undefined;

/** What the new facts leave behind in the database, or undefined. */
export function tokenRolesRemoval(previous: Facts, next: Facts): string | undefined {
  const before = previous?.declaredRoles ?? [];
  if (before.length === 0 || (next?.declaredRoles ?? []).length > 0 || next?.prunesTokenRoles) return undefined;
  return `the program no longer declares token role ${before.join(", ")}: crud refuses it from this release on, and the database keeps it registered and granted until a release runs the prune; write \`state: tokenRoles: {}\` for one (docs/identity.md#token-roles-and-trusted-issuers)`;
}
