import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBuildInfo } from './buildInfo.js';

const SHA = 'aa3f1a6d0c0ffee1234567890abcdef12345678';

test('env BUILD_COMMIT / BUILD_TIME win (a deploy script sets them); git is not called', () => {
  let called = false;
  const info = readBuildInfo({ env: { BUILD_COMMIT: SHA.toUpperCase(), BUILD_TIME: '2026-11-19T07:22:09Z' }, run: () => { called = true; return ''; } });
  assert.deepEqual([info.commit, info.shortCommit, info.builtAt, info.source, info.dirty], [SHA, 'aa3f1a6', '2026-11-19T07:22:09.000Z', 'env', null]);
  assert.equal(called, false);
  assert.ok(!Number.isNaN(Date.parse(info.startedAt)));
});

test('else the git checkout: HEAD, its commit time, and whether tracked files changed', () => {
  const run = (cmd, args) => (args[0] === 'rev-parse' ? `${SHA}\n` : args[0] === 'log' ? '2026-11-19T12:52:09+05:30\n' : ' M server.js\n');
  const info = readBuildInfo({ env: {}, run });
  assert.deepEqual([info.commit, info.builtAt, info.source, info.dirty], [SHA, '2026-11-19T07:22:09.000Z', 'git', true]);
});

test('no env and no git -> nulls, never a guess; a malformed BUILD_COMMIT is ignored', () => {
  const info = readBuildInfo({ env: { BUILD_COMMIT: 'not a sha; rm -rf' }, run: () => { throw new Error('no git'); } });
  assert.deepEqual([info.commit, info.builtAt, info.source], [null, null, null]);
});
