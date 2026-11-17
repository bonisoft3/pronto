// The Cloudflare Workers runtime every Worker pronto deploys runs on: its
// compatibility date, which pins workerd's behaviour for the Worker. One date
// for them all, so Workers that call each other (the dispatcher and the
// isolates it binds, the SSR renderer and its database) never run on
// different semantics, and moving the runtime is one line.
export const PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE = '2026-09-01'
