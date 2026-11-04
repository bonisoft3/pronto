const before = Deno.env.get("HATCH_SPIKE_MARKER") ?? null;
Deno.env.set("HATCH_SPIKE_MARKER", "child-value");
console.log(
	JSON.stringify({ before, after: Deno.env.get("HATCH_SPIKE_MARKER") }),
);
