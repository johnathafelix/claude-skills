const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('prod-monitor scripts preserve config, window, digest, resume and ticket invariants', () => {
  const result = spawnSync('python3', [path.join(__dirname, 'prod_monitor_test.py'), '-v'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
