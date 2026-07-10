# Guideline: Naming

Names are the readable surface of Go code. Check identifiers against Go naming idioms. You check ONLY naming — declarations, types, and docs are other guidelines' jobs.

Extended examples (consult only for an ambiguous case): `~/.claude/skills/golang-check/references/idioms.md`

## Flag

- **Distance rule violated.** Name length should scale with scope. Flag verbose names in tiny scopes (`index` for a loop counter → `i`) and cryptic names in wide scopes (package-level `dp` → descriptive). Loop index single letter; short local 1–3 chars; exported self-documenting.
- **Receiver names.** Flag `self`, `this`, `me`; flag receivers that aren't a 1–2 letter abbreviation of the type (`client` → `c`); flag inconsistent receiver names across methods of the same type.
- **Initialisms not all-caps.** `Url`, `Http`, `Id`, `Api`, `Json` → `URL`, `HTTP`, `ID`, `API`, `JSON`. In mixed: `userId` → `userID`, `HttpClient` → `httpClient`.
- **Package names.** Flag `util`, `common`, `misc`, `shared`, `helpers`, `types`, `base`. Flag uppercase, underscores, or plural package names (`userStore`, `user_store`, `users` → `userstore`/`user`).
- **Stutter.** `widget.NewWidget()` → `widget.New()`; `user.UserService` → `user.Service`; method on `*Project` named `ProjectName()` → `Name()`.
- **Getter `Get` prefix.** `u.GetName()` → `u.Name()`. (Setters keep `Set`: `u.SetName(n)`.)
- **Interface name for one-method interface** not `method + er`: a one-method `Read` interface should be `Reader`; honor canonical names — a `String() string` method's interface/type uses `String`, not `ToString`.
- **Constants in `ALL_CAPS` or `K`-prefix**, or named by value not role: `const ALL_CAPS`, `const KMaxRetries`, `const Twelve = 12` → MixedCaps named by role (`MaxRetries`).
- **Type encoded in name:** `var numUsers int` → `var users int`; `userList []User` → `users []User`.
- **Unexported global naming:** package-level errors should be `errXxx` (lowercase) when unexported, `ErrXxx` when exported.

## Don't flag

- Established domain abbreviations that are clear in context.
- Test files' throwaway names unless egregiously misleading.
- Single-letter names that ARE idiomatic for their scope (`i`, `r`, `w`, `b`, `ctx`, `tt` in tests).
