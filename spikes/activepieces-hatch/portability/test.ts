import { piece } from "./piece.ts";
import { descriptor, invoke } from "./runner.ts";
function equal(actual: unknown, expected: unknown) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
	}
}
async function rejects(fn: () => Promise<unknown>, expected: string) {
	try {
		await fn();
	} catch (error) {
		if (error instanceof Error && error.message.includes(expected)) return;
		throw error;
	}
	throw new Error(`Expected rejection: ${expected}`);
}
Deno.test("static piece, auth, exposure and context boundary", async () => {
	equal(descriptor(), [{
		name: "greeting",
		actions: ["greet", "needs-store"],
	}]);
	const result = await invoke("greeting", "greet", {
		name: "Ada",
		punctuation: "!",
	}, "accepted-token");
	equal(result, { greeting: "Hello, Ada!" });
	if (JSON.stringify([descriptor(), result]).includes("accepted-token")) {
		throw new Error("Secret escaped");
	}
	await rejects(
		() => invoke("greeting", "greet", { name: "Ada" }, "wrong"),
		"Unauthorized",
	);
	await rejects(
		() => invoke("greeting", "hidden", {}, "accepted-token"),
		"Action not exposed",
	);
	await rejects(
		() => invoke("greeting", "needs-store", {}, "accepted-token"),
		"Unsupported context capability: store",
	);
	await rejects(() => invoke("greeting", "greet", {}, ""), "Missing auth");
});
Deno.test("raw run does not apply SDK property defaults or required validation", async () => {
	equal(piece.getAction("greet")!.props.punctuation.defaultValue, "!");
	equal(await invoke("greeting", "greet", {}, "accepted-token"), {
		greeting: "Hello, undefinedundefined",
	});
});
