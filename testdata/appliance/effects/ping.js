export async function issue(input, sink) {
  const r = await sink.fetch("/ping", { method: "POST", body: { id: input.id } });
  if (r.status !== 200) throw new Error(`ping stub answered ${r.status}`);
  return { done: r.body };
}
