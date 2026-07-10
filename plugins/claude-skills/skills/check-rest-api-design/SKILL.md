---
name: check-rest-api-design
description: USE WHEN designing, reviewing, or changing a REST/HTTP API and you want it checked against REST design best practices — resource/URI modeling, HTTP method semantics, query params (filtering/sorting/pagination), status codes, request/response body shape, idempotency, async jobs, non-CRUD actions, caching/conditional requests, versioning, and cross-cutting concerns. Fans out parallel sub-agents (one per section-bucket) so the check runs fast and the findings — not the file dumps — come back to the main context. Checks route definitions, controllers/handlers, OpenAPI specs, diffs, or a described design against the bundled guide and reports violations with location, the rule broken, and the fix. Invoke via /check-rest-api-design.
allowed-tools: Task, Read, Grep, Glob, Bash
argument-hint: [files, dir, OpenAPI spec, PR/diff, or a described endpoint]
---

# REST API Design Check

Check a REST/HTTP API against the bundled design guide (`reference.md`, colocated with this file) and report where it deviates, why, and how to fix it.

**This skill reports; it does not edit by default.** Surface findings and let the user decide. Apply fixes only if the user explicitly asks — a URI or method change ripples into clients, tests, and docs.

`reference.md` is the source of truth for the *why* behind every rule (13 sections + rationale + trade-offs). The checklist below is the fast path; **read `reference.md` before judging any finding whose rule is contested** (§3 boolean-vs-enum, §4 `400`/`422`, §5 envelope, §6 mutability, §11 versioning) — the guide flags where the field disagrees, and a "violation" may be a legitimate documented choice.

## Procedure

### Step 1 — Determine scope

Pick what to check, in this order:

1. If the user named files, a directory, an OpenAPI/Swagger spec, or a described endpoint, use that.
2. If the user says "this PR" / "my changes" / "the diff", diff against the base branch:
   - `gh pr view --json baseRefName --jq '.baseRefName'` for the PR base; else fall back to `main`.
   - `git diff <base>...HEAD` for changed route/handler/schema files.
3. Otherwise ask the user what to check (paste endpoints, point at route files, or name a spec).

Find the API surface: route/router definitions, controllers/handlers, OpenAPI/Swagger YAML/JSON, GraphQL is out of scope (this guide is REST). Prefer graph tools / `Grep` for route decorators (`@Get`, `router.post`, `app.route`, path strings) to locate endpoints fast.

### Step 2 — Decide: fan out or inline

**Default to fanning out** — it runs the buckets in parallel and keeps file contents out of the main context (only compressed findings return). Skip the fan-out and check inline **only** when scope is tiny: a single endpoint, ≤2 handlers, or a design described in the prompt with no files to read. Spawning agents then costs more than it saves — read `reference.md` yourself and go straight to Step 5.

### Step 3 — Fan out sub-agents (parallel)

Spawn the buckets below **in a single message so they run concurrently** (`Task`, `Explore` or `general-purpose` agent type). Each sub-agent does the reading; the main thread stays clean and only receives findings.

Give every sub-agent:
- the exact file scope from Step 1 (paths, or the diff range),
- the absolute path to the guide: `reference.md` sits in this skill's own directory (alongside this SKILL.md). Resolve it to an absolute path from this SKILL.md's location before handing it to sub-agents — do NOT hardcode a home directory (Read won't expand `~`),
- its assigned bucket + the matching checklist slice from Step 4,
- this instruction: **"Read the listed sections of reference.md and the scoped files. Report ONLY a findings table, one line per finding, format `<file>:<line> — <severity> [§N]: <problem>. Fix: <change>.` No source dumps, no preamble, no praise. If a rule is a documented trade-off, say which choice was made instead of flagging it wrong. Return `NONE` if clean."**

Buckets (one sub-agent each):

| Agent | Sections | Focus |
|---|---|---|
| 1. URIs & methods | §1, §2 | resource/URI modeling, nesting, pluralization, method semantics, PUT vs PATCH |
| 2. Query params | §3 | filter/behavior split, boolean-vs-enum, sorting, pagination, search |
| 3. Status codes | §4 | specific codes, `201`+`Location`, `400`/`422`, `401`/`403`, retries |
| 4. Body & errors | §5 | naming case, dates, money, enums, error envelope, DB leakage |
| 5. Lifecycle & semantics | §6–§10 | mutability/soft-delete, idempotency, async jobs, non-CRUD actions, caching |
| 6. Cross-cutting & versioning | §11–§13 | versioning, HATEOAS, rate limiting, trace IDs, OpenAPI, bulk |

For a **large surface** (many route files), additionally shard files across duplicated agents within a bucket (or give each agent a file subset) — but keep the total bounded (~6–12 agents). **Note any sharding in the final report** so silent gaps don't read as "all clean."

### Step 4 — Criteria catalog

Each sub-agent applies the slice for its bucket (numbered to match the table above). For every endpoint (and shared body/error shapes):

**Bucket 1 — Resource & URI (§1)**
- Path is a plural noun; no verbs in path (unless a justified §9 action).
- Nesting is shallow — parent segment only where it adds context; member ops (`GET`/`PATCH`/`DELETE` by id) are flat.
- Exactly one canonical URI per resource; no second address for the same thing.
- Plural + lowercase + hyphens (not `snake_case`/`camelCase`) in path segments; trailing-slash policy consistent; IDs opaque.
- Filtered views are the same collection with query params, not new endpoints (`/active-prices` smell).

**Bucket 1 — Methods (§2)**
- Method matches intent; `GET` is safe (no side effects, no meaningful body).
- `PUT` = full replace (whole representation); `PATCH` = partial merge. Not `PUT`-with-merge-semantics.
- `PUT` exists only if "replace wholesale" is a real use case; otherwise `PATCH`.
- `POST` that creates → `201` + `Location` header.

**Bucket 2 — Query params (§3)**
- Filters live in query params, not split into endpoints (combinatorial explosion).
- Booleans reconsidered as enums where a third state is plausible; meaning of *absent* is defined (tri-state trap).
- Behavior flags that reinterpret another param → two mutually-exclusive named params (`key` vs `keyPattern`), not a dangling boolean.
- Structured filters use bracket paths (`?customFields[region]=eu`), not URL-encoded JSON blobs.
- One multi-value convention (comma or repeated key), used consistently.
- Single `sort` param with a sign convention; sortable fields whitelisted server-side.
- Pagination chosen deliberately — cursor for large/mutating data, offset only for small/stable/admin lists; metadata (`next`, cheap-only total) returned.
- Free-text search is its own param (`?q=`), not overloaded structured filters.

**Bucket 3 — Status codes (§4)**
- Specific code, never `200` + error body.
- `201`+`Location` on create; `204` for empty-body success (`DELETE`, no-return `PUT`/`PATCH`); `202` for async.
- `400` = unparseable vs `422` = valid syntax/failed validation (or `400` for both, consistently).
- `401` = unauthenticated (+`WWW-Authenticate`) vs `403` = authenticated-but-forbidden; `405`+`Allow`; `409` conflict; `429`+`Retry-After`.
- `5xx` never leaks stack traces.

**Bucket 4 — Body design (§5)**
- One field-naming case everywhere (no mixing camelCase/snake_case).
- Dates ISO 8601 UTC with `Z`/offset; no epoch-vs-string mixing.
- Money as integer minor units (+`currency`) or decimal string — never a float.
- Enums are strings, not magic numbers.
- One uniform error envelope (e.g. RFC 9457) with a stable machine code + trace/request ID.
- Response/request envelope decision applied consistently.
- No DB leakage (internal FKs, soft-delete flags, raw columns).

**Bucket 5 — Lifecycle & semantics (§6–§10)**
- History-sensitive domains: consider immutable + soft-delete (`DELETE` flips a flag) over in-place edits.
- Non-idempotent creates accept an `Idempotency-Key`.
- Slow operations return `202` + a pollable job resource (not a held-open connection).
- Non-CRUD actions: sub-resource collection if it creates a record; `PATCH` status if a flag flip; verb sub-path only as last resort, with `POST`.
- Caching: `ETag`/`If-None-Match`→`304`; conditional writes `If-Match`→`412`; deliberate `Cache-Control`.

**Bucket 6 — Cross-cutting (§11–§13)**
- Versioning: whole-API not per-endpoint; additive changes don't bump; breaking changes do; no breaking within a version.
- HATEOAS pragmatic: at least `self` + pagination `next`/`prev` links where useful.
- Rate limiting, trace IDs, OpenAPI spec, compression, HTTPS-only, bulk endpoints (all-or-nothing vs partial-success documented).

**Above all (meta-principle):** consistency beats correctness. Flag any endpoint that disagrees with the conventions the rest of the API already uses — even a locally-fine choice is a finding if it's inconsistent.

### Step 5 — Aggregate & report

Collect the sub-agents' findings tables (or your inline findings). In the main thread: merge them, drop duplicates where buckets overlap, and apply the **consistency meta-principle across buckets** — an inconsistency (e.g. `camelCase` params in one file, `snake_case` in another) is only visible once the tables are side by side, so no single sub-agent will catch it. Then group by severity. One line per finding:

```
<file>:<line> — <severity> [§N]: <what's wrong>. Fix: <concrete change>.
```

- **severity**: `HIGH` (breaks clients / wrong semantics — wrong method, `200`-on-error, float money, no idempotency on risky create), `MED` (convention/consistency — pluralization, naming case, missing `Location`), `LOW` (nice-to-have — ETags, sparse fields, HATEOAS links).
- Cite the section (`§3`, `§4`) so the user can read the rationale in `reference.md`.
- For **contested** rules, state it's a documented trade-off and name the choice rather than marking it wrong.
- End with the checklist as a pass/fail summary and the single most important fix.

Do not invent endpoints not in scope. If scope is a described design (no code), skip file:line and cite the endpoint/param by name.
