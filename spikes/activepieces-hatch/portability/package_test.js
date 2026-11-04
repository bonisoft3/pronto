import { piece } from "@pronto-spike/local-greeting-piece";

Deno.test("package exports a callable standard piece", async () => {
	const result = await piece.getAction("greet").run({
		auth: { type: "SECRET_TEXT", secret_text: "accepted-token" },
		propsValue: { name: "Ada", punctuation: "!" },
	});
	if (result.greeting !== "Hello, Ada!") throw new Error("Unexpected result");
});
