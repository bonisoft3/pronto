// The smoke's secret field: the PIN its row's writer typed reaches the sink in
// the body, beside a key from the environment in a header, both handed in by
// the airlock and neither in the ledger.
export async function issue(request, sink, secrets) {
  const r = await sink.fetch("/v1/pix", { method: "POST", body: { amount: request.amount, pin: secrets.pin }, headers: { "X-Pix-Key": secrets.PIX_KEY } });
  if (r.status >= 300) throw new Error("sink answered " + r.status);
  return { done: { status: r.status } };
}
