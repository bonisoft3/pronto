const { piece } = require("@pronto-spike/local-greeting-piece");
piece.getAction("greet").run({
  auth: { type: "SECRET_TEXT", secret_text: "accepted-token" },
  propsValue: { name: "Ada", punctuation: "!" },
}).then((result) => {
  if (result.greeting !== "Hello, Ada!") throw new Error("Unexpected result");
  console.log(result);
});
