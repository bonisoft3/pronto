// Every secret a deployed effect reads must exist where the target keeps them.
// The edge reads its environment per call, so a missing one otherwise surfaces
// only when an order fails. Names only: no target hands a value back, and none
// is asked for.

/** The secret names effects.json declares: the handlers' and the credentials'. */
export function declaredSecrets(manifest: string): string[] {
  const effects = (JSON.parse(manifest) as { effects: Record<string, { secrets?: string[]; credential?: { secret: string } }> }).effects;
  return [...new Set(Object.values(effects).flatMap((e) => [...(e.secrets ?? []), ...(e.credential ? [e.credential.secret] : [])]))].sort();
}

/** Names a target's own listing holds, or throws what is missing. */
export function requireSecrets(declared: string[], held: string[]): void {
  const missing = declared.filter((name) => !held.includes(name));
  if (missing.length > 0) throw new Error(`the deployment holds no ${missing.join(", ")}, which its effects declare`);
}

/** `wrangler secret list`'s JSON, as names. */
export function wranglerSecretNames(listing: string): string[] {
  return (JSON.parse(listing) as { name: string }[]).map((s) => s.name);
}
