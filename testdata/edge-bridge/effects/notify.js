// The edge-bridge fixture's handler for an effect whose bridge runs on docker
// alone and whose sink on cloudflare is an origin, never run.
export async function issue(input, sink) {
  return { done: (await sink.fetch('/notify', { method: 'POST', body: input })).body }
}
