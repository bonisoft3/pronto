// The edge-bridge fixture's handler for a bridge not on cloudflare, never run.
export async function issue(input, sink) {
  return { done: (await sink.fetch('/confirm', { method: 'POST', body: input })).body }
}
