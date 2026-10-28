// Verification Airlock: rollback enforcement for post-release write mutations.
//
// Domain machines remain pure: Cortex statecharts declare business transitions
// only and carry no test-specific rollback states. Instead, post-release write
// journeys are wrapped in an Airlock that pairs the forward user journey with a
// mandatory compensating rollback executed in a finally block.

export interface AirlockDoor {
  mutate: (action: string, payload?: unknown) => Promise<unknown>;
  [key: string]: unknown;
}

export interface AirlockContext<T = unknown> {
  door?: AirlockDoor;
  targetUrl?: string;
  token?: string;
  /** Records intermediate state to ensure rollback executes even if execute throws later. */
  recordState?: (state: T) => void;
  [key: string]: unknown;
}

export interface AirlockSpec<T = unknown> {
  /** Acceptance claim id this journey realizes (e.g. {#accept-...}). */
  accepts?: string;
  /** Screen name exercised by the journey. */
  screen: string;
  /** Role under which the journey executes. */
  role?: string;
  /** Forward journey execution in the browser. Returns state needed for compensation. */
  execute: (page: any, ctx?: AirlockContext<T>) => Promise<T>;
  /** Post-execution assertions. */
  verify?: (page: any, state: T, ctx?: AirlockContext<T>) => Promise<void>;
  /** Compensating rollback executed in finally block to ensure zero net delta. */
  rollback: (state: T, door?: AirlockDoor) => Promise<void>;
}

export interface AirlockJourney<T = unknown> {
  spec: AirlockSpec<T>;
  run: (page: any, ctx?: AirlockContext) => Promise<void>;
}

/**
 * Wraps a write journey in an airlock with guaranteed compensating rollback.
 * Refuses any write spec that does not declare a rollback function.
 */
export function airlock<T = unknown>(spec: AirlockSpec<T>): AirlockJourney<T> {
  if (typeof spec.rollback !== "function") {
    throw new Error(
      `Airlock journey for screen '${spec.screen}' (${spec.accepts ?? "unnamed"}) must define a compensating rollback function.`
    );
  }

  return {
    spec,
    async run(page: any, ctx?: AirlockContext<T>) {
      let state: T | undefined = undefined;
      let primaryErr: unknown = null;

      const runCtx: AirlockContext<T> = {
        ...ctx,
        recordState(s: T) {
          state = s;
        },
      };

      try {
        const res = await spec.execute(page, runCtx);
        if (res !== undefined) {
          state = res;
        }
        if (spec.verify) {
          await spec.verify(page, state as T, runCtx);
        }
      } catch (err) {
        primaryErr = err;
        throw err;
      } finally {
        try {
          await spec.rollback(state as T, ctx?.door);
        } catch (rollbackErr) {
          if (primaryErr) {
            const pMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
            const rMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
            throw new Error(
              `Airlock journey failed (${pMsg}) and compensating rollback also failed: ${rMsg}`
            );
          }
          throw rollbackErr;
        }
      }
    },
  };
}
