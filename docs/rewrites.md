# Rewrites

A rewrite is a path a client already calls, kept as it is and answered at a path the
door already answers: an app that replaces another system serves that system's
endpoints without a service of its own. It is Next.js's
[`rewrites`](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites),
a subset, so what is known of those holds here and what the subset leaves out is
refused, never ignored.

```cue
state: rewrites: {
    "payment-list":    {source: "/expense/payments",             destination: "/crud/payment_list"}
    "payment-detail":  {source: "/expense/payments/:id",         destination: "/crud/payment_list?id=eq.:id", methods: ["GET"]}
    "payment-total":   {source: "/expense/payments/:id/total",   destination: "/crud/rpc/payment_total?id=:id", methods: ["GET"]}
    "payment-approve": {source: "/expense/payments/:id/approve", destination: "/crud/rpc/payment_approve", methods: ["POST"]}
}
```

| Field | Is |
|---|---|
| `source` | path-to-regexp's literal and `:name` segments, the first a literal, since the door tries a rewrite before its own routes. A parameter is letters, digits and `. _ ~ -`, so its value carries no second query parameter |
| `destination` | a [PostgREST](https://docs.postgrest.org/en/stable/references/api.html) path under `/crud`: a table, a view or `rpc/<function>`, with any query, naming the parameters it uses as `:name`; a colon after a name is PostgREST's own, an alias (`select=codigo:id`) or a cast, and is left as written |
| `methods` | the methods the rewrite answers, as Vercel's `routes` spell it; without it, every method |

The request is handed on as it came: its method, body, `Authorization` and query, the
query after the destination's own. So a rewrite answers what `/crud` answers the same
caller, PostgREST judging the credential and the role's grants and policies deciding
what each method may do. A path or method no rewrite names is not a rewrite's to
answer.

What a table, view or function at the destination is remains the app's: a view or a
function comes from `state.rawMigrations` or a SQL hatch, with its grants, and
PostgREST answers 404 for one that does not exist. A function answers whatever shape
it returns, which is how a rewrite keeps a response shape the client already parses.

One thing PostgREST does not take from a URL: a `POST`'s arguments, which it reads
from the body alone. The door therefore states the path the client asked for in
`X-Rewrite-Path`, which a function reads as
`current_setting('request.headers', true)::json ->> 'x-rewrite-path'`.

Refused:

- `has`, `missing`, `basePath` and `locale`; a wildcard (`:path*`), an optional or a
  pattern (`:id(\\d+)`) in `source`;
- a `destination` anywhere but under `/crud`, another origin included, or naming a
  parameter its `source` does not;
- a `source` under one of the door's own paths (`/crud`, `/signal`, `/auth`, …);
- two rewrites one request matches, a parameter of one standing where the other
  has a parameter or a word, unless their `methods` do not meet.

A rewrite shadows a document at the same path.

The container door alone applies rewrites, so a program that declares one is refused
the `pages` and `cloudflare` targets. Both already answer `/crud`, the edge's Worker
and the page's service worker, so each can apply the same rewrite ahead of it; the
edge's PostgREST does not answer `rpc/` yet, and a page serves only itself.

The alternatives not taken:

- **A vocabulary of Pronto's own** (`view:`, `rpc:`, a parameter implied as a filter).
  It was built first and dropped: three things to learn where two grammars already
  known say the same, and a mapping only the container door could read.
- **OpenAPI `paths`.** It describes a contract, not where a path is answered, so the
  destination would live in an extension of our own. It is what to generate from
  the rewrites for a client that wants the contract.
- **A credential toggle.** A rewrite reaches nothing `/crud` does not give the same
  caller, so dropping `Authorization` protected nothing. A client whose token
  PostgREST cannot verify is a question of sign-in, not of a path.
- **A [signal](signals.md)**, which sends one event to one row and answers nothing of
  it, or **a container hatch with a door**, which serves any path at the cost of a
  service to write, run and bound.
