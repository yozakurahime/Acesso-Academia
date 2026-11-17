import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndApplyGitUpdate } from '../src/edge-runner.js';

test('checkAndApplyGitUpdate returns up_to_date when HEAD equals origin/main', async () => {
  const calls = [];
  const runCmd = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'rev-parse') return { stdout: 'abc1234', stderr: '' };
    return { stdout: '', stderr: '' };
  };

  const res = await checkAndApplyGitUpdate({ runCmd });
  assert.equal(res.updated, false);
  assert.equal(res.reason, 'up_to_date');
  assert.equal(calls.length, 3);
});

test('checkAndApplyGitUpdate pulls changes and detects selfChanged + depsChanged', async () => {
  const calls = [];
  const runCmd = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      const pullDone = calls.some((c) => c[1] === 'pull');
      return { stdout: pullDone ? 'def5678' : 'abc1234', stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') {
      return { stdout: 'def5678', stderr: '' };
    }
    if (args[0] === 'diff') {
      return { stdout: 'src/edge-runner.js\npackage.json\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const res = await checkAndApplyGitUpdate({ runCmd });
  assert.equal(res.updated, true);
  assert.equal(res.oldHead, 'abc1234');
  assert.equal(res.newHead, 'def5678');
  assert.equal(res.depsChanged, true);
  assert.equal(res.selfChanged, true);
  assert.ok(calls.some((c) => c[1] === 'install' && c[2] === '--omit=dev'));
});
