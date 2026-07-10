# A Practical Guide to REST API Design

A working reference, organized by topic. It's opinionated: where there's a defensible best practice, it says so and explains *why*; where the field genuinely disagrees, it flags the trade-off and lets you choose. Examples lean on a `shops / products / prices` domain so the abstract rules stay concrete.

The single most important meta-principle, before any specific rule: **consistency beats correctness.** A slightly suboptimal convention applied everywhere is easier to use than five locally-perfect conventions that disagree. Pick your rules and hold the line.

---

## 1. Resource modeling & URI design

### Resources are nouns; HTTP methods are the verbs
The URL names a *thing*; the method says what you're doing to it. `GET /prices` and `DELETE /prices/42`, never `/getPrices` or `/deletePrice`. If you find yourself wanting a verb in the path, you almost always want a different method on a noun instead. (The rare exceptions — actions that aren't CRUD — get their own section below.)

### One resource, one canonical URI
Every resource should have exactly one "official" address. If a price has its own ID, its canonical URI keys off that ID: `/shops/:shop/prices/:price-id`. Exposing the *same* price at a second address (`/shops/:shop/products/:sku/prices/:price-id`) means two URIs for one thing — bad for caching, bad for clients, bad for your own mental model. Pick one.

### Shallow nesting
Nest only as deep as you need to *establish context*, then flatten. Creation needs the parent (a price is born under a product), so `POST` nests. But once a price has an ID, the parent is redundant — the ID alone identifies it — so member operations go flat:

```
POST   /shops/:shop/products/:sku/prices    # create: needs product context
GET    /shops/:shop/prices/:id              # read/update/delete: id is enough
PATCH  /shops/:shop/prices/:id
DELETE /shops/:shop/prices/:id
```

This asymmetry (nested create, flat member) is standard — Rails calls it *shallow nesting*, GitHub's API does it throughout. It keeps deep URLs out of your everyday calls while preserving hierarchy where it's actually informative.

### Collections vs members
A plural noun is a **collection** (`/prices`); the collection plus an identifier is a **member** (`/prices/42`). Operations distribute predictably:

| | Collection `/prices` | Member `/prices/42` |
|---|---|---|
| `GET` | list (paginated, filterable) | fetch one |
| `POST` | create a new member | — (usually) |
| `PUT` | — (rarely: replace whole collection) | full replace |
| `PATCH` | — | partial update |
| `DELETE` | — (rarely: clear collection) | delete one |

### Filtered views are the same collection, not new resources
`/prices?sku=ABC` is the prices collection *filtered*, not a different resource. Resist minting `/product-prices` or `/active-prices`. This is the mental model that makes filtering-by-query-param feel natural (see §3).

### Small conventions that pay off
- **Plural, consistent.** `/prices`, `/products`, `/shops` — all plural, always. Don't mix `/price/42` with `/products`.
- **Hyphens in path segments, not underscores or camelCase.** `/shop-configs`, not `/shop_configs` or `/shopConfigs`. (This is about the *path*; JSON field naming is a separate decision — see §5.)
- **Lowercase paths.** URLs are effectively case-sensitive; don't make callers guess.
- **No trailing slash**, or always a trailing slash — pick one and redirect the other.
- **IDs are opaque.** Clients shouldn't parse meaning out of them. This frees you to change ID schemes later.

---

## 2. HTTP methods & their semantics

The two properties that govern method choice:

- **Safe** = doesn't change server state. `GET`, `HEAD`, `OPTIONS`. A crawler can hit these freely.
- **Idempotent** = calling N times has the same effect as calling once. `GET`, `PUT`, `DELETE`, `HEAD` are idempotent; `POST` is not; `PATCH` usually isn't.

| Method | Safe | Idempotent | Use |
|---|---|---|---|
| `GET` | ✅ | ✅ | Read. Never has side effects. Never has a request body that matters. |
| `POST` | ❌ | ❌ | Create, or non-idempotent actions. |
| `PUT` | ❌ | ✅ | Full replace. Send the *entire* representation. |
| `PATCH` | ❌ | ❌* | Partial update. Send only what changes. |
| `DELETE` | ❌ | ✅ | Remove. |

*Idempotency matters because clients and proxies retry idempotent requests automatically after a timeout. If your `POST /prices` isn't protected, a retry creates a duplicate price. See §7.

### PUT vs PATCH — the distinction people get wrong
`PUT` **replaces the whole resource.** If you `PUT {amount: 500}` and the price also had a `currency`, a strict `PUT` sets `currency` to null/absent — you sent a complete new representation and omitted it. `PATCH` **merges** — `PATCH {amount: 500}` touches only `amount`.

In practice most people want `PATCH` for updates and skip `PUT` entirely. Offer `PUT` only if "replace this resource wholesale" is a real use case for you. Don't implement `PUT` with merge semantics — that violates the contract and confuses anyone who knows the difference.

### POST does double duty
`POST` means "process this according to the resource's own rules." That's creation *most* of the time, but it's also the right method for genuine actions that aren't idempotent (§9). When `POST` creates something, respond `201 Created` with a `Location` header pointing at the new resource's canonical URI.

---

## 3. Query parameters: filtering, sorting, pagination, fields

This is where your original question lives, so it gets the most depth.

### The rule that dissolves the "no boolean params" advice
Before choosing a shape for any parameter, ask: **does it filter the collection, or change the endpoint's behavior?**

- **Filtering** = "which members come back." Belongs in query params, always. `?sku=ABC`, `?status=active`.
- **Behavior** = "how the endpoint interprets the request." This is the category the "avoid boolean params" advice was actually aimed at — and even here the fix is *better parameter design*, not a new endpoint.

Splitting *filters* into endpoints is a mistake: filters are combinatorial (`status × sku × key` would explode into dozens of endpoints) and you'd lose the one-collection-many-views model. Keep filters as params.

### Booleans are often enums in disguise
`?isActive=true` works, but a boolean is lossy the moment the domain grows a third state — `scheduled`, `expired`, `draft`. You'd be stuck migrating. Model status as an enum from the start:

```
?status=active      # instead of ?isActive=true
```

Bonus: a boolean in a query string is secretly **tri-state** — `true`, `false`, and *absent*. You owe an explicit answer for what omission means. An enum with an explicit "all" value removes the ambiguity:

```
?status=active | inactive | all
```

Stripe and most mature pricing APIs use a status enum rather than an `active` flag for exactly this reason.

### Behavior flags: change the parameter, not the endpoint
A flag like `skipRegex` that changes *how another param is interpreted* is the real smell — it's an orphan whose meaning depends on a second param being present (`skipRegex=true` with no `key` is meaningless). Don't add an endpoint; make the intent live in *which parameter you send*:

```
?key=foo            # exact match
?keyPattern=foo.*   # regex / pattern match
```

Now the two modes are mutually exclusive by construction, self-documenting, and there's no dangling flag. This generalizes: **whenever a boolean toggles interpretation, look for two mutually-exclusive named parameters instead.**

### Structured filters: flatten, don't embed blobs
Passing `?customFields={"region":"eu"}` means URL-encoding a JSON blob — awkward to build, unreadable in logs. If the filterable keys are known, use bracket paths so each is its own greppable param:

```
?customFields[region]=eu&customFields[tier]=gold
```

### Multiple values
Pick one convention for "any of these" and stick to it:

```
?status=active,scheduled      # comma-delimited (compact, common)
?status=active&status=scheduled   # repeated key (explicit, RFC-friendly)
```

Comma-delimited is more readable; repeated-key handles values that contain commas. Choose per your data.

### Sorting
A single `sort` param, with a sign or direction convention:

```
?sort=-createdAt,amount    # minus = descending; createdAt desc, then amount asc
```

Whitelist sortable fields server-side. Don't let callers sort by arbitrary columns — it's an index/performance footgun.

### Pagination — offset vs cursor
Two families, real trade-off:

**Offset/limit** (`?limit=20&offset=40` or `?page=3&pageSize=20`)
- Simple; lets clients jump to arbitrary pages.
- Breaks under mutation: if a row is inserted while paging, items shift and you get duplicates or skips.
- Slow at large offsets (`OFFSET 100000` still scans).

**Cursor/keyset** (`?limit=20&cursor=eyJpZCI6NDJ9`)
- Stable under inserts/deletes; fast at any depth (it's a `WHERE id > :cursor`).
- Can't jump to "page 47"; only next/prev.
- The cursor is opaque — usually a base64-encoded pointer to the last item's sort key.

Default to **cursor** for anything that mutates or grows large (feeds, logs, event streams). Offset is fine for small, stable, admin-facing lists. Always return pagination metadata (a `next` cursor/link, and total count *only if it's cheap* — on big tables `COUNT(*)` is expensive, so many APIs omit it deliberately).

### Field selection (sparse fieldsets)
Let clients trim payloads:

```
?fields=id,amount,currency
```

Worth adding when responses are fat and clients are mobile/bandwidth-sensitive. Skip it early if payloads are small — it's real complexity.

### Search vs filter
Filtering is exact/structured (`?status=active`). Free-text search is fuzzy and belongs in its own param (`?q=summer sale`) — don't overload structured filters to do full-text matching.

---

## 4. Status codes

Use the specific code; don't return `200` with an error body. Clients (and your own retry logic, caches, and monitoring) read the status line.

### The set you'll actually use

**2xx — success**
- `200 OK` — general success with a body (reads, updates that return the resource).
- `201 Created` — resource created. Include a `Location` header with its URI. Usually returns the new resource in the body too.
- `202 Accepted` — request accepted for async processing; not done yet (§8).
- `204 No Content` — success, deliberately empty body. Standard for `DELETE`, and for `PUT`/`PATCH` when you don't return the updated resource.

**3xx — redirection**
- `304 Not Modified` — conditional GET; client's cached copy is still fresh (§10).

**4xx — client error (they broke it)**
- `400 Bad Request` — malformed syntax, unparseable body, invalid param types.
- `401 Unauthorized` — not authenticated (misnamed; it means "unauthenticated"). Send `WWW-Authenticate`.
- `403 Forbidden` — authenticated but not allowed.
- `404 Not Found` — no such resource. Also a legitimate privacy choice instead of `403`, to avoid revealing that a resource exists.
- `405 Method Not Allowed` — resource exists, method doesn't apply. Send an `Allow` header listing valid methods.
- `409 Conflict` — request conflicts with current state (duplicate unique key, edit conflict, illegal state transition).
- `410 Gone` — existed, deliberately removed, won't come back. Kinder than `404` for deprecated resources.
- `422 Unprocessable Entity` — syntax is fine but semantics fail *validation* (e.g., `amount: -5`). See the `400` vs `422` note below.
- `429 Too Many Requests` — rate limited. Send `Retry-After`.

**5xx — server error (you broke it)**
- `500 Internal Server Error` — unhandled failure. Never leak stack traces.
- `502 / 503 / 504` — bad gateway / service unavailable / gateway timeout. `503` should carry `Retry-After` when you can estimate it.

### Two distinctions worth internalizing
- **`400` vs `422`.** `400` = "I couldn't even parse this" (bad JSON, wrong types). `422` = "I parsed it fine, but it fails business rules" (negative amount, unknown currency). The split lets clients distinguish "fix your serialization" from "fix your data." Some teams use `400` for both to keep it simple — acceptable, just be consistent.
- **`401` vs `403`.** `401` = who are you? (no/invalid credentials). `403` = I know who you are, and no.

---

## 5. Request & response body design

### Naming: pick a case and never mix
`camelCase` (JS-native, dominant in JSON APIs) or `snake_case` (Python/Ruby ecosystems, Stripe). Either is fine; **mixing is not.** Whatever you pick, every field in every endpoint follows it.

### Dates and times: ISO 8601, UTC
`"2026-07-01T14:18:26Z"`. Always. No epoch millis in one field and formatted strings in another; no ambiguous local times without offset. Suffix `Z` (or an explicit offset) so there's no timezone guessing.

### Money: never a float
Floats can't represent `0.10` exactly — you'll get rounding drift. Use minor units as an integer (`amount: 1050` for $10.50) plus a `currency` (`"USD"`), the way Stripe does. Or a decimal string (`"10.50"`) if you must keep the decimal point. Never a JSON number with a fractional part for money.

### Enums are strings, not magic numbers
`"status": "active"`, not `"status": 2`. Self-documenting, and you can add values without a decoder ring. Document the allowed set.

### Consistent error shape — adopt a standard
Pick one error envelope and use it for *every* error. [RFC 9457 (Problem Details)](https://www.rfc-editor.org/rfc/rfc9457) is a good off-the-shelf choice:

```json
{
  "type": "https://api.example.com/errors/validation",
  "title": "Validation failed",
  "status": 422,
  "detail": "amount must be a positive integer",
  "errors": [
    { "field": "amount", "message": "must be >= 0" }
  ]
}
```

Include a **stable machine-readable code** (the `type` URI, or a `code` field). Human-readable messages get reworded; clients should branch on the code, not the prose. Add a request/trace ID to every error so support can find it in your logs.

### The envelope question (genuinely contested)
Do you wrap successful responses?

```json
// Enveloped
{ "data": { "id": 42, "amount": 1050 }, "meta": { "requestId": "..." } }

// Bare
{ "id": 42, "amount": 1050 }
```

- **Bare** is cleaner and lets clients deserialize straight into a model. Pagination/metadata then lives in headers (`Link`, `X-Total-Count`).
- **Enveloped** gives a uniform place for pagination and meta, at the cost of an extra `.data` everywhere.

Both are defensible. Decide once, apply everywhere. A common middle path: bare single resources, light envelope for collections (so pagination has a home):

```json
{
  "data": [ /* prices */ ],
  "pagination": { "next": "cursor...", "hasMore": true }
}
```

### Don't leak your database
The response shape is a contract, not a table dump. Don't expose internal FKs, soft-delete flags, or columns clients shouldn't see. Renaming a DB column shouldn't break your API — keep a mapping layer.

---

## 6. Mutability: consider immutable + soft-delete

For domains where history matters — pricing especially — think hard before allowing in-place edits. Many pricing systems (Stripe among them) treat prices as **immutable**: you never `PATCH` an amount. To change a price you deactivate the old one and create a new one.

Benefits:
- Clean audit trail — "what did this cost last Tuesday?" is always answerable.
- No mutation races on the money field.
- References stay stable — an order pointing at price `42` always means the same amount.

If this fits, drop `PUT`/`PATCH` on prices entirely and model changes as **create + soft-delete**, where `DELETE` flips an `active`/`archivedAt` flag rather than hard-deleting. Smaller surface, better history. (Soft-delete is worth considering broadly: hard `DELETE` destroys audit trails and can orphan references. A `DELETE` that sets `deletedAt` and disappears the resource from default listings is often what you actually want.)

---

## 7. Idempotency & safe retries

Networks drop responses. A client that sent `POST /prices`, timed out, and didn't hear back doesn't know if it succeeded — so it retries, and now you have two prices.

The fix is **idempotency keys**: the client generates a unique key per logical operation and sends it as a header:

```
POST /shops/acme/products/ABC/prices
Idempotency-Key: 9f8b7c6d-...
```

The server records the key with the result of the first successful call. A retry with the same key returns the *stored* result instead of re-executing. This is how Stripe makes card charges safe to retry. Implement it for any non-idempotent mutation where a duplicate would hurt.

(`PUT` and `DELETE` are already idempotent by design — retrying "set to X" or "delete 42" is harmless. It's `POST` that needs the key.)

---

## 8. Async & long-running operations

If an operation can't finish within a request (bulk import, report generation, anything slow), don't hold the connection open. Return `202 Accepted` with a handle to a **job resource** the client can poll:

```
POST /shops/acme/price-imports
→ 202 Accepted
  Location: /shops/acme/price-imports/job-123

GET /shops/acme/price-imports/job-123
→ 200 { "status": "processing", "progress": 0.4 }
→ 200 { "status": "completed", "result": { "created": 500 } }
```

The job is itself a resource with its own lifecycle. Clients poll (with backoff), or you offer webhooks so they don't have to. This keeps request timeouts sane and makes progress observable.

---

## 9. Actions that don't fit CRUD

Sometimes you need a verb — "publish this", "cancel that", "refund" — that isn't naturally create/read/update/delete. Two accepted approaches:

**Model the action as a sub-resource (preferred when it creates a record):**
```
POST /shops/acme/orders/42/refunds     # a refund is a real thing worth storing
POST /shops/acme/prices/42/activations
```
A refund *is* an entity (amount, reason, timestamp) — creating one via `POST` on a collection is clean REST.

**State transition via `PATCH` on the resource's status (when it's just a flag flip):**
```
PATCH /shops/acme/prices/42
{ "status": "active" }
```

**Last resort — a verb sub-path** for actions that are genuinely neither:
```
POST /shops/acme/orders/42/cancel
```
Purists dislike it, but it's widely used (GitHub, Stripe both do it) and honest about intent. Use `POST` (these actions have side effects and usually aren't idempotent). Don't twist a genuine action into a fake resource just to avoid a verb — clarity wins.

The test: *does the action produce a record worth addressing later?* Yes → sub-resource collection. It's just a status change → `PATCH`. Neither → verb sub-path, sparingly.

---

## 10. Caching & conditional requests

Cheap wins, often skipped.

**ETags** — the server sends a version tag with a resource:
```
GET /prices/42 → 200  ETag: "a1b2c3"
```
The client caches it and revalidates cheaply:
```
GET /prices/42  If-None-Match: "a1b2c3"
→ 304 Not Modified        # nothing changed, empty body, saves bandwidth
```

**Conditional writes prevent lost updates** — the same tag guards against overwriting someone else's edit:
```
PATCH /prices/42  If-Match: "a1b2c3"
→ 412 Precondition Failed   # someone edited it since you read it; re-fetch and retry
```
This is optimistic concurrency control, and it's the clean answer to "two clients editing the same resource."

**Cache-Control** tells clients/proxies how long a response stays fresh (`Cache-Control: max-age=60`). Set it deliberately on cacheable reads; mark volatile or private data `no-store`.

---

## 11. Versioning

You'll change the API incompatibly someday. Plan the seam now.

- **URI versioning** (`/v1/shops/...`) — visible, dead-simple to route, trivially cacheable. Purists object that `/v1` and `/v2` of the same shop are "different URIs for the same resource," but it's the most common approach for exactly its bluntness. (You're already doing this.)
- **Header versioning** (`Accept: application/vnd.example.v2+json`) — keeps URIs pure, but harder to test in a browser and easier for clients to forget.

Either works; URI versioning is the pragmatic default. Whichever you pick:
- **Version the whole API, not per-endpoint.** Per-resource versions become a combinatorial nightmare.
- **Additive changes don't need a version bump.** Adding an optional field or a new endpoint is backward-compatible — clients ignore what they don't know. Reserve version bumps for *breaking* changes (removing/renaming fields, changing types, tightening validation).
- **Never break within a version.** The contract of `/v1` is frozen once clients depend on it.

---

## 12. HATEOAS — know it, apply it pragmatically

The "hypermedia" tenet of pure REST says responses should include links to related actions, so clients navigate by following links rather than hard-coding URLs:

```json
{
  "id": 42,
  "amount": 1050,
  "status": "active",
  "_links": {
    "self":       { "href": "/shops/acme/prices/42" },
    "deactivate": { "href": "/shops/acme/prices/42", "method": "PATCH" },
    "product":    { "href": "/shops/acme/products/ABC" }
  }
}
```

Full HATEOAS is rare in practice — most "REST" APIs are really "HTTP APIs" and that's fine. But two ideas from it are cheap and genuinely useful: **returning a `self` link**, and **returning `next`/`prev` links for pagination** so clients don't reconstruct cursor URLs by hand. Adopt those; treat the rest as optional.

---

## 13. Cross-cutting concerns

- **Rate limiting.** Return `429` with `Retry-After`, and surface budget in headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`) so good clients self-regulate.
- **Request/trace IDs.** Attach one to every request and echo it in responses and error bodies. It's the difference between a debuggable and an undebuggable production incident.
- **Documentation as contract.** Maintain an OpenAPI spec. It generates clients, drives contract tests, and is the single source of truth. Hand-written docs drift; a spec that lives next to the code doesn't.
- **Compression.** `gzip`/`br` on responses — near-free bandwidth savings, usually just a gateway toggle.
- **HTTPS only.** No plaintext, ever. Redirect or reject.
- **Bulk operations.** When clients need to act on many items, offer a batch endpoint rather than forcing N calls (`POST /prices/batch` with an array). Decide up front whether it's all-or-nothing (transactional) or partial-success (return per-item results with individual statuses) — and document which.

---

## Quick-reference checklist

Design review pass for any new endpoint:

- [ ] Path is a plural noun; no verbs (unless a justified action, §9).
- [ ] Nesting is shallow — parent only where it adds context.
- [ ] The resource has exactly one canonical URI.
- [ ] Method matches intent; `POST`/`PATCH` for the right things; `PUT` only if full-replace is real.
- [ ] Filters are query params; behavior toggles are expressed as distinct params, not endpoints.
- [ ] Booleans reconsidered as enums where a third state is plausible; absent-value meaning is defined.
- [ ] Pagination chosen deliberately (cursor for large/mutating data); metadata returned.
- [ ] Status codes are specific; `201` carries `Location`; validation errors are `422` (or a consistent `400`).
- [ ] Error shape is uniform and carries a stable machine code + trace ID.
- [ ] Field naming, dates (ISO 8601 UTC), and money (integer minor units) follow one convention.
- [ ] Non-idempotent creates accept an idempotency key.
- [ ] Slow operations return `202` + a pollable job.
- [ ] Breaking changes go behind a version; additive changes don't.
- [ ] Consistent with every other endpoint you already have.

---

*The through-line: model resources as nouns, let HTTP's verbs and status codes carry the semantics, express variation through parameters rather than proliferating endpoints, and — above all — be relentlessly consistent. Most "is this RESTful?" questions answer themselves once you ask "is this a filter or a behavior?" and "does this thing deserve its own URI?"*
