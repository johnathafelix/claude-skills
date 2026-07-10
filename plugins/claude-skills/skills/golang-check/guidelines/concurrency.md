# Guideline: Concurrency

Goroutines, channels, synchronisation, context cancellation, and data races. Concurrency bugs are high-cost — flag confidently but explain the race/leak.

Extended examples (consult only for an ambiguous case): `../references/concurrency.md`

## Flag

### Lifecycle
- **Fire-and-forget goroutine:** a `go func(){...}()` with no predictable exit condition AND no way to wait for it (no `WaitGroup`/done channel/errgroup). Leaks memory; flag.
- **Goroutine in `init()`** — spawn in constructors with lifecycle management instead.
- **`wg.Add` inside the goroutine** instead of before launching it (race on the counter).
- **Passing an HTTP request context to a background goroutine** that outlives the response (`go work(r.Context())`) — it cancels when the response is sent. Use `context.WithoutCancel(r.Context())` (Go 1.21+).

### Channels
- **Buffer size > 1 without justification.** Size 0 or 1 is the default; a larger buffer needs a reason you can state (what bounds it).
- **Channel direction omitted** in a function signature where it's one-directional (`chan T` → `<-chan T` or `chan<- T`).
- **Close from the receiver side**, or a close where concurrent sends may still happen (send on closed channel panics). Close from the sender, after all sends finish.

### Sync primitives
- **Embedded `sync.Mutex`/`sync.WaitGroup`** (promotes `Lock`/`Unlock` to the public API) → use a named field `mu sync.Mutex`.
- **Copying a `sync.Mutex`** or a struct containing one (passing by value after it's used).
- **Manual `WaitGroup` + error collection** where `errgroup.WithContext` fits better.
- **Missing `defer mu.Unlock()`** after `mu.Lock()` in a function with multiple return paths (risk of held lock on early return).
- Simple flag/counter guarded by a mutex where `sync/atomic` (`atomic.Bool`, `atomic.Int64`) is simpler — minor, low confidence.

### Data races
- **`append` to a shared slice** then handing both slices to goroutines (shared backing array). Copy before passing.
- **Map/slice assigned to another var then mutated concurrently** (same backing storage; needs `maps.Clone`/copy inside the critical section).
- **`fmt`-formatting an object that has a `String()`/`Error()` method while holding the same mutex that method locks** — potential deadlock.

### Other
- **Nil-channel misuse** that blocks forever unintentionally (distinct from the deliberate "remove case from select" trick).

## Don't flag

- Deliberate `nil` channel used to disable a `select` case (with a comment).
- Buffered channels with a stated, bounded justification.
- Test code spawning goroutines with `t` synchronisation.
