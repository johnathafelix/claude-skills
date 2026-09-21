# Prefer Object Params Over Long Positional Parameter Lists

Functions with several parameters — especially when some are optional — are error-prone to call: arguments are matched by position, so a caller must remember the exact order, and skipping an optional parameter in the middle forces passing `undefined` as a placeholder. Replace these with a single destructured object parameter instead.

Not every multi-parameter function needs this. A function with 1-2 required, unambiguous parameters (e.g. `add(a: number, b: number)`) is fine as-is. The rule targets: 3+ parameters, OR any parameter that is optional / has a default, OR call sites that already pass `undefined` to skip one.

## Rule

**Rule.** When a function takes 3+ parameters, or has optional/defaulted parameters, define it with a single destructured object parameter instead of positional arguments.

**Rationale.** Object params make call sites self-documenting (named fields instead of positional guesswork), let callers omit any optional field without touching the others, and make adding a new optional field non-breaking for existing call sites.

```ts
// BAD
function createUser(username: string, email: string, age: number, isAdmin?: boolean) {
  console.log(`Creating user ${username} (${email}), Age: ${age}. Admin: ${isAdmin ?? false}`);
}

createUser("Alex99", "alex@example.com", 28, undefined);
```

```ts
// GOOD
interface CreateUserParams {
  username: string;
  email: string;
  age: number;
  isAdmin?: boolean;
}

function createUser({ username, email, age, isAdmin = false }: CreateUserParams) {
  console.log(`Creating user ${username} (${email}), Age: ${age}. Admin: ${isAdmin}`);
}

createUser({
  email: "alex@example.com",
  username: "Alex99",
  age: 28,
});
```

---

## Signal: A Call Site Passes `undefined` as a Placeholder

**Rule.** If any existing call site passes `undefined` (or a "default" value like `null`, `""`, `0`) purely to skip a parameter and reach one after it, that is direct evidence the signature should be an object.

```ts
// BAD
function scheduleRetry(delayMs: number, maxAttempts: number, onFailure?: () => void, label?: string) {
  void delayMs; void maxAttempts; void onFailure;
  console.log(label ?? "retry");
}

scheduleRetry(1000, 3, undefined, "checkout-retry");
```

```ts
// GOOD
interface ScheduleRetryParams {
  delayMs: number;
  maxAttempts: number;
  onFailure?: () => void;
  label?: string;
}

function scheduleRetry({ delayMs, maxAttempts, onFailure, label = "retry" }: ScheduleRetryParams) {
  void delayMs; void maxAttempts; void onFailure;
  console.log(label);
}

scheduleRetry({ delayMs: 1000, maxAttempts: 3, label: "checkout-retry" });
```

---

## Exceptions

**Rule.** Do not flag:
- Functions with 1-2 required parameters and no optional/defaulted ones.
- A single trailing callback parameter (e.g. `array.map((item) => ...)`, event handlers) — this is an established idiom, not a positional-argument problem.
- Overload-based APIs where positional arity itself carries meaning (rare; treat case by case).

```ts
// FINE — do not flag
function add(a: number, b: number): number {
  return a + b;
}

function onClick(handler: (event: MouseEvent) => void): void {
  void handler;
}
```
