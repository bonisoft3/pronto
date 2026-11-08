export async function issue(request, sink) {
  const r = await sink.fetch("/v1/charges", { method: "POST", body: request });
  if (r.status >= 300) throw new Error("sink answered " + r.status);
  return { done: { status: r.status } };
}
