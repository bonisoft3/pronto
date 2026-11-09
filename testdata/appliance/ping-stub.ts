const port = Number(Deno.args[0] ?? "8091");
Deno.serve({ hostname: Deno.args[1] ?? "127.0.0.1", port }, () => Response.json({ answer: "from-the-stub" }));
