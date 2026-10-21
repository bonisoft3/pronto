export const HYBRID_NAME = /^[a-z][a-z0-9_]{0,30}$/;

/** The machine declaration carried to browser and edge runtimes. */
export function declaredMachine(
  {
    name,
    version,
    fuel,
    entropy,
    initial,
    initialize,
    state,
    view,
    public: shown,
    contracts,
    events,
    states,
  }: Record<string, unknown>,
) {
  return {
    name,
    version,
    fuel,
    entropy,
    initial,
    initialize,
    state,
    view,
    public: shown,
    contracts,
    events,
    states,
  };
}
