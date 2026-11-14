// The edge-bridge fixture's handler: what renderEffects binds, never run.
export async function issue(input, sink) {
  const res = await sink.fetch('/acquire', { method: 'POST', body: input })
  return res.status === 200 ? { done: res.body } : { failed: { status: res.status, reason: res.body } }
}
