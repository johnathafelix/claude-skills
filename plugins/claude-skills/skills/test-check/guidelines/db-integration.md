# Guideline: Database operations are covered by integration tests

Code that issues database operations must be exercised against a **real database engine** in tests — a container (Docker, testcontainers), a local service the suite starts, or an in-memory/embedded engine of the same family (SQLite for SQL when the production dialect allows it, `pglite`/embedded Postgres, `mongodb-memory-server`, `miniredis`, DynamoDB Local, Firestore emulator). Mocking the driver or the ORM proves only that the code calls the mock; it proves nothing about the query, the schema, the constraints, or the mapping.

**Mocking the database is accepted for one thing:** simulating server-side failures that a real engine will not produce on demand — connection lost, timeout, deadlock, `serialization_failure`, disk full. Those paths may use a mocked driver, `sqlmock`, or a fault-injecting wrapper.

## Identifying DB operations in the changed code

Look in the changed source files for:

- SQL text (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `WITH`) in strings or query builders (`squirrel`, `goqu`, `knex`, `kysely`, `drizzle`).
- Driver/ORM calls: `db.Query*`, `db.Exec*`, `tx.*`, `pgx`, `sqlx`, `gorm`, `ent`, `prisma.*`, `typeorm` repositories, `mongoose`/`mongo-driver` collection methods, `redis` commands, `dynamodb` `PutItem`/`Query`.
- Repository / store / DAO / adapter layers by convention (`repository/`, `store/`, `persistence/`, `*Repo`, `*Store`).
- Migrations and schema changes — these need at least one test that runs them against a real engine.

## How to check

For each changed function or method that issues a DB operation:

1. Find its tests (changed or pre-existing). Trace what the test wires in: a real connection (`testcontainers`, `dockertest`, `pgxpool.Connect` to a test DSN, `sqlite3 :memory:`, `new PrismaClient()` against a test schema, `MongoMemoryServer.create()`), or a mock (`sqlmock`, `mockery`-generated `DB`/`Querier`, `jest.mock('../db')`, `prisma-mock`, hand-rolled fakes).
2. Classify each test as **integration** (real engine) or **mocked**.
3. The operation passes when at least one integration test executes it on its main path. Error-path tests may be mocked.
4. Check the integration test actually **reads back** through the engine after a write (a second query, or a repository `Get`) rather than trusting the write's return value — that is where mapping and constraint bugs surface.

If the repository has **no** integration-test infrastructure at all (no container setup, no test DSN, no in-memory engine dependency), report that once as a repository-level finding rather than once per operation, and still list the changed operations it leaves unproven.

## Patterns to flag

- **Repository method tested only with a mocked driver/ORM** — `sqlmock.ExpectQuery("SELECT .*")` proving the string was sent, not that it returns the right rows.
- **New SQL or query-builder chain with no test executing it** against an engine.
- **New migration or schema change with no test applying it.**
- **Integration test present but the changed operation is not on its path** (e.g. the new `ListByTenant` was added but only `Get` is exercised).
- **Integration test that mocks the write and only integrates the read**, or vice versa.
- **Happy path mocked, error path integrated** — inverted; the error path is where mocking is allowed.
- **Service-layer test that mocks the repository** — this is fine on its own, but if it is the *only* test for a changed repository method, the repository method is unproven.

## What NOT to flag

- Mocked DB in tests whose name/assertions are about connection loss, timeouts, deadlocks, transaction rollback on driver error, retry/backoff behavior.
- Mocking the repository interface from the service layer up, when the repository itself has integration tests.
- Pure in-memory fakes used for **non-DB** collaborators.
- Read-only code that only maps rows to structs with no engine interaction — unless the mapping is what changed and no integration test reads back through it.

## What to report

- `line` — the changed function/method that issues the operation, in the **source** file. `endLine` — its closing line.
- `symbol` — `(*PostgresOrderRepo).DeleteByID`, `OrderRepository.listByTenant`.
- `description` — the operation and how it is (or is not) tested: `"issues DELETE FROM orders WHERE id = $1; the only test is TestDeleteByID using sqlmock, which asserts the SQL string and returns 1 row affected."`
- `rationale` — what a real engine would catch that the mock cannot: `"a wrong column name, a missing index, or a foreign-key cascade is invisible to sqlmock; the delete has never run against Postgres."`
- `action` — the test to add, stated as intent: `"add a testcontainers Postgres test that seeds two orders, calls DeleteByID(o1), and asserts o2 is still returned by GetByID."` Name the existing integration harness if the repo has one (file path), so the reader reuses it.
- `severity` — `error` for a write operation (INSERT/UPDATE/DELETE/migration) with no integration test; `warning` for a read.
- `confidence` — `high` when you traced the test wiring to a mock or found no test; `medium` when the harness is indirect (shared fixture, build tag) and you could not confirm what runs.

A mock that stands in for the database on the happy path is a finding; a mock that stands in for a database *failure* is the accepted exception — keep the two apart in every report.
