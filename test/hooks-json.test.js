// Locks the Stop-hook registration invariants. These are asserted mechanically
// because they are load-bearing and invisible: nothing in the hook sources
// enforces the order, and the one comment that documents it can go stale.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'claude-skills');
const HOOKS = path.join(PLUGIN, 'hooks');

const config = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));

function commandsFor(event) {
  return config.hooks[event]
    .flatMap(group => group.hooks)
    .map(h => h.command);
}

function basenames(event) {
  return commandsFor(event).map(c => {
    const m = c.match(/hooks\/([A-Za-z0-9._-]+\.js)/);

    return m ? m[1] : c;
  });
}

test('Stop hooks run in the documented order', () => {
  // format-with-prettier MUST stay last: it never blocks, so it is the only hook
  // guaranteed to run on the final Stop of a continuation chain, which is what
  // makes it the last thing to touch the files. Reordering silently breaks that.
  assert.deepStrictEqual(basenames('Stop'), [
    'auto-code-simplifier.js',
    'enforce-golang-check.js',
    'enforce-ts-check.js',
    'format-with-prettier.js',
  ]);
});

test('every registered hook command points at a file that exists', () => {
  for (const event of Object.keys(config.hooks)) {
    for (const base of basenames(event)) {
      assert.ok(
        fs.existsSync(path.join(HOOKS, base)),
        event + ' registers ' + base + ', which does not exist',
      );
    }
  }
});

test('every registered hook declares a timeout', () => {
  for (const event of Object.keys(config.hooks)) {
    for (const h of config.hooks[event].flatMap(g => g.hooks)) {
      assert.strictEqual(typeof h.timeout, 'number', h.command + ' has no numeric timeout');
      assert.ok(h.timeout > 0, h.command + ' has a non-positive timeout');
    }
  }
});

test('format-with-prettier has NO stop_hook_active guard', () => {
  // Deliberate, and load-bearing for the ordering guarantee above. Its own
  // header comment says "do NOT add the guard back". This test is the mechanism
  // that makes that comment true.
  const src = fs.readFileSync(path.join(HOOKS, 'format-with-prettier.js'), 'utf8');

  assert.ok(
    !/if\s*\(\s*input\.stop_hook_active\s*\)/.test(src),
    'format-with-prettier.js gained a stop_hook_active guard — this breaks the ordering guarantee documented in its header',
  );
});

test('auto-code-simplifier keeps its stop_hook_active guard', () => {
  // Not in scope for the enforce-hook rework; if it ever loses this guard it
  // gains an unbounded continuation loop.
  const src = fs.readFileSync(path.join(HOOKS, 'auto-code-simplifier.js'), 'utf8');

  assert.ok(
    /if\s*\(\s*input\.stop_hook_active\s*\)/.test(src),
    'auto-code-simplifier.js lost its stop_hook_active guard',
  );
});

test('hooks subtree stays pinned to commonjs', () => {
  // The nearest package.json for everything under hooks/ — including hooks/lib/.
  // The root package.json deliberately omits "type"; if this file were removed,
  // require() in the hooks would break the moment the root gained "type":"module".
  const pkg = JSON.parse(fs.readFileSync(path.join(HOOKS, 'package.json'), 'utf8'));

  assert.strictEqual(pkg.type, 'commonjs');
});

test('root package.json does not declare a module type', () => {
  // skills/*/workflow.js are ESM-syntax but never loaded by Node's resolver;
  // the root is nonetheless their nearest manifest. Omitting "type" preserves
  // today's behavior exactly. See the comment in package.json.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  assert.ok(!('type' in pkg), 'root package.json declared a "type" — see test comment');
});
