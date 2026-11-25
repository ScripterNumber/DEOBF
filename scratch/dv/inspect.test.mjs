import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const inspector = resolve('scratch/dv/inspect.ts');
const chunk = `-- Непустой UTF-8 комментарий
return {
  run = function(d, index) return d:handle(index) end,
  handle = function(d, index) return d[index](d) end,
  [399] = function(d) return 42 end,
  caller = function(d, arg) return d:run(arg) end
}`;

test('reports literal bytes, computed slots, and dispatcher callers without executing Lua', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-dv-'));
  try {
    const file = join(dir, 'wrapper.lua');
    const buffer = join(dir, 'literal.bin');
    writeFileSync(file, `local CHUNK = [=[\n${chunk}\n]=]\nlocal HEX = [[00ff]]\n`);
    const output = execFileSync(process.execPath, ['--import', 'tsx', inspector, file, 'CHUNK', 'HEX', 'run', '399', buffer], { encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.chunk.sha256, createHash('sha256').update(chunk + '\n', 'utf8').digest('hex'));
    assert.equal(result.payload.first16Hex, '00ff');
    assert.deepEqual(readFileSync(buffer), Buffer.from([0, 255]));
    assert.equal(result.analysis.parseErrors, 0);
    assert.equal(result.analysis.computedIndexes.length, 1);
    assert.equal(result.analysis.computedIndexes[0].expression, 'd[index]');
    assert.deepEqual(result.analysis.computedIndexes[0].dispatcherCalls[0].arguments, ['index']);
    assert.deepEqual(result.analysis.computedIndexes[0].selectorBindings, ['index']);
    assert.equal(result.analysis.callers[0].field, 'caller');
    assert.equal(result.analysis.selectedSlot.key, '399');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects malformed hex rather than truncating it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-dv-'));
  try {
    const file = join(dir, 'wrapper.lua');
    writeFileSync(file, `local CHUNK = [=[${chunk}]=]\nlocal HEX = [[00f]]\n`);
    assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', inspector, file, 'CHUNK', 'HEX', 'run'], { stdio: 'pipe' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
