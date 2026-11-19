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
    "payment-update":  {source: "/expense/payments/:id",         destination: "/crud/rpc/payment_update", methods: ["PUT"]}
    "payment-search":  {source: "/expense/search",               destination: "/crud/rpc/payment_search", methods: ["GET"]}
}
```

| Field | Is |
|---|---|
| `source` | path-to-regexp's literal and `:name` segments, the first a literal, since the door tries a rewrite before its own routes. A parameter is letters, digits and `. _ ~ -`, so its value carries no second query parameter |
| `destination` | a [PostgREST](https://docs.postgrest.org/en/stable/references/api.html) path under `/crud`: a table, a view or `rpc/<function>`, with any query, naming the parameters it uses as `:name`; a colon after a name is PostgREST's own, an alias (`select=codigo:id`) or a cast, and is left as written |
| `methods` | the methods the rewrite answers, as Vercel's `routes` spell it, matched on the method the client used; without it, every method |

The request is handed on as it came: its method, body, `Authorization` and query, the
query after the destination's own; a function at the destination is asked by the
method and with the query [it takes](#a-function-at-the-destination). So a rewrite
answers what `/crud` answers the same caller, PostgREST judging the credential and
the role's grants and policies deciding what each method may do. A path or method no
rewrite names is not a rewrite's to answer.

The door also states what the client asked, in the two headers Caddy's
[`forward_auth`](https://caddyserver.com/docs/caddyfile/directives/forward_auth) and
Traefik's ForwardAuth state it in: `X-Forwarded-Method`, the method, and
`X-Forwarded-Uri`, the request target byte for byte as the client sent it. The door
sets both on the request it hands on, so a value a client sends in either is
replaced, and naming one in `Connection` removes nothing; and it removes both from a
request to `/crud` itself, where nothing was rewritten and a function is told
nothing.

What a table, view or function at the destination is remains the app's: a view or a
function comes from `state.rawMigrations` or a SQL hatch, with its grants, and
PostgREST answers 404 for one that does not exist. A function answers whatever shape
it returns, which is how a rewrite keeps a response shape the client already parses.

## A function at the destination

PostgREST [calls a function](https://docs.postgrest.org/en/stable/references/api/functions.html)
by `GET` or `POST` alone, takes a `POST`'s arguments from the body alone, and binds
a query's keys to arguments one to one. A path another system already calls owes it
none of that, so a rewrite to `rpc/<function>` differs from one to a table or view
in two things:

- a `PUT`, `PATCH` or `DELETE` reaches the function as a `POST`, its body untouched.
  A `GET` or `HEAD` stays one, in PostgREST's read-only transaction;
- the client's query is not handed on. The destination's own (`rpc/payment_total?id=:id`)
  is the function's arguments, and the function reads the client's from
  `X-Forwarded-Uri`.

PostgREST reads the query of a `POST` as filters on what the function returns, never
as its arguments. So a destination's query is a function's arguments under `GET` and
`HEAD` alone, and a rewrite to `rpc/<function>` with one states `methods` and names
no other; under any other method the function takes a path parameter from
`X-Forwarded-Uri`.

A function reads the two headers as
`current_setting('request.headers', true)::json ->> 'x-forwarded-uri'` and
`->> 'x-forwarded-method'`.

The door matches a `source` against the path cleaned and decoded, and the header is
the target as sent, so the two differ wherever the client's spelling does:
`/expense/payments/zzz/../abc` matches `/expense/payments/:id` as `abc` and reaches
the function with `zzz` as its fourth segment; `//expense/payments/abc` moves every
segment by one, `%61bc` is `abc` unescaped, and a target in absolute form begins
`http://`. A function therefore takes a parameter by a pattern anchored on the whole
path, as the examples here do, which reads the plain spelling and finds nothing in
any other, so that their update meets no row; it does not count segments. What it
reads is the caller's word, never proof of what matched, to be checked as an
argument would be.

A key the client repeats (`status=1&status=2`), which binds to no argument, is in the
query, all that follows the first `?`, whole and percent-encoded as sent, and decoding a value is the
function's. This one decodes nothing: its statuses are plain words, and a value
escaped (`%70ending`) or holding anything else matches none.

```sql
-- GET /expense/search?status=pending&status=settled
CREATE FUNCTION payment_search() RETURNS SETOF payment_list LANGUAGE sql STABLE AS $$
  SELECT * FROM payment_list WHERE status = ANY (
    SELECT split_part(pair, '=', 2)
    FROM unnest(string_to_array(substring(current_setting('request.headers', true)::json ->> 'x-forwarded-uri' from '[?](.*)$'), '&')) AS pair
    WHERE split_part(pair, '=', 1) = 'status')
$$;
```

The body is PostgREST's to read, as on `/crud/rpc`: a JSON object's keys are the
arguments by name, or the whole body is the one unnamed `json` or `jsonb` argument;
no body calls the function that takes none, and is an error (`400`) for one that
takes the body. A path called both with a body and without is therefore two
functions of one name, `f()` and `f(json)`: no body, or `{}`, calls the first, and
any other object the second.

```sql
-- PUT /expense/payments/:id
CREATE FUNCTION payment_update(json) RETURNS json LANGUAGE sql AS $$
  UPDATE payment SET status = $1 ->> 'status'
  WHERE id = substring(current_setting('request.headers', true)::json ->> 'x-forwarded-uri' from '^/expense/payments/([0-9a-f-]{36})([?]|$)')::uuid
  RETURNING row_to_json(payment)
$$;
```

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

## A path another system calls

A path another system calls with its own credential is a rewrite like any
other: the request's `Authorization` reaches PostgREST, which switches to the
[declared token role](identity.md#token-roles-and-trusted-issuers) the token
names, and the function's grant decides. Onfly's expense service answers
`POST /expense/advance-payment/{id}/residual` to an automation alone; the
endpoint is the application's SQL and one rewrite:

```cue
state: {
    tokenRoles: residual_bot: note: "the expense automation, which derives an advance payment's residual"
    rewrites: "advance-residual": {source: "/expense/advance-payment/:id/residual", destination: "/crud/rpc/advance_residual", methods: ["POST"]}
    rawMigrations: [{name: "020_advance_residual.sql", src: "sql/advance_residual.sql"}]
}
```

```sql
CREATE FUNCTION advance_residual() RETURNS json LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO advance_payment (amount, parent_id)
  SELECT p.amount - p.settled, p.id FROM advance_payment p
  WHERE p.id = substring(current_setting('request.headers', true)::json ->> 'x-forwarded-uri' from '^/expense/advance-payment/([0-9a-f-]{36})/residual([?]|$)')::uuid
  RETURNING row_to_json(advance_payment)
$$;
REVOKE EXECUTE ON FUNCTION advance_residual() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advance_residual() TO residual_bot;
```

A person's token reaches the function and is refused (`403`), anon likewise
(`401`), and a token the issuer signed for another app's audience never
reaches it.
