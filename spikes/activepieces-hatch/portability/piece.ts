import {
	createAction,
	createPiece,
	PieceAuth,
	Property,
} from "@activepieces/pieces-framework";

const auth = PieceAuth.SecretText({ displayName: "API token", required: true });
const greet = createAction({
	auth,
	name: "greet",
	displayName: "Greet",
	description: "Check a token and greet a person.",
	props: {
		name: Property.ShortText({ displayName: "Name", required: true }),
		punctuation: Property.ShortText({
			displayName: "Punctuation",
			required: false,
			defaultValue: "!",
		}),
	},
	run({ auth, propsValue }) {
		if (auth.secret_text !== "accepted-token") throw new Error("Unauthorized");
		return Promise.resolve({
			greeting: `Hello, ${propsValue.name}${propsValue.punctuation}`,
		});
	},
});
const hidden = createAction({
	auth,
	name: "hidden",
	displayName: "Hidden",
	description: "Not exposed.",
	props: {},
	run() {
		return Promise.resolve("hidden");
	},
});
const needsStore = createAction({
	auth,
	name: "needs-store",
	displayName: "Needs store",
	description: "Exercises the context boundary.",
	props: {},
	async run({ store }) {
		return await store.get("key");
	},
});
export const piece = createPiece({
	displayName: "Local greeting",
	description: "A standard local piece.",
	logoUrl: "",
	authors: [],
	auth,
	actions: [greet, hidden, needsStore],
	triggers: [],
});
