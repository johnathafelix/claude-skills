// Locks hook registration invariants. These are asserted mechanically because
// they are load-bearing and invisible: a hook can be registered with a broken
// path or no timeout and nothing in the sources will say so.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const PLUGIN = path.join(__dirname, "..", "plugins", "claude-skills");
const HOOKS = path.join(PLUGIN, "hooks");

const config = JSON.parse(
  fs.readFileSync(path.join(HOOKS, "hooks.json"), "utf8"),
);

// hooks.json nests hooks inside matcher groups, so every assertion below starts
// by flattening the groups for one event.
function registered(event) {
  return config.hooks[event].flatMap((group) => group.hooks);
}

function basenames(event) {
  return registered(event).map(({ command }) => {
    const m = command.match(/hooks\/([A-Za-z0-9._-]+\.js)/);

    return m ? m[1] : command;
  });
}

test("every registered hook command points at a file that exists", () => {
  for (const event of Object.keys(config.hooks)) {
    for (const base of basenames(event)) {
      assert.ok(
        fs.existsSync(path.join(HOOKS, base)),
        event + " registers " + base + ", which does not exist",
      );
    }
  }
});

test("every registered hook declares a timeout", () => {
  for (const event of Object.keys(config.hooks)) {
    for (const h of registered(event)) {
      assert.strictEqual(
        typeof h.timeout,
        "number",
        h.command + " has no numeric timeout",
      );
      assert.ok(h.timeout > 0, h.command + " has a non-positive timeout");
    }
  }
});

test("hooks subtree stays pinned to commonjs", () => {
  // The nearest package.json for everything under hooks/ — including hooks/lib/.
  // The root package.json deliberately omits "type"; if this file were removed,
  // require() in the hooks would break the moment the root gained "type":"module".
  const pkg = JSON.parse(
    fs.readFileSync(path.join(HOOKS, "package.json"), "utf8"),
  );

  assert.strictEqual(pkg.type, "commonjs");
});

test("root package.json does not declare a module type", () => {
  // skills/*/workflow.js are ESM-syntax but never loaded by Node's resolver;
  // the root is nonetheless their nearest manifest. Omitting "type" preserves
  // today's behavior exactly. See the comment in package.json.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );

  assert.ok(
    !("type" in pkg),
    'root package.json declared a "type" — see test comment',
  );
});
