import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function run(body, opcode = '3') {
  const dir = mkdtempSync(join(tmpdir(), 'prism-handler-'));
  try {
    const file = join(dir, 'wrapper.lua');
    const chunk = `return {[1]=function() if E == 201 then while true do local dE=g[t]; ${body} end end end}`;
    writeFileSync(file, `local CHUNK = [=[${chunk}]=]`);
    return execFileSync(process.execPath, ['--import', 'tsx', resolve('scratch/dv/handler.ts'), file, 'CHUNK', '1', 'E', '201', 'dE', opcode], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('selects opcode branch but retains unrelated conditional', () => {
  const result = JSON.parse(run('if dE >= 2 then if dE == 3 then a() else b() end else c() end; if flag then d() end; t=t+1'));
  assert.equal(result.fetch, 'local dE = g[t];');
  assert.match(result.statements[0], /a\(\)/);
  assert.match(result.statements[1], /if flag then/);
  assert.doesNotMatch(result.statements.join('\n'), /[bc]\(\)/);
});

test('rejects a reassigned opcode variable', () => {
  assert.throws(() => run('dE = 1; if dE == 3 then a() end'));
});

test('selects each opcode in a requested interval', () => {
  const result = JSON.parse(run('if dE == 3 then a() else b() end', '2:3'));
  assert.equal(result.handlers.length, 2);
  assert.match(result.handlers[0].statements[0], /b\(\)/);
  assert.match(result.handlers[1].statements[0], /a\(\)/);
});

test('keeps conditions that use a shadowing local', () => {
  const result = JSON.parse(run('if dE == 3 then local dE = 1; if dE == 1 then a() else b() end end'));
  assert.match(result.statements.join('\n'), /if dE == 1 then/);
  assert.match(result.statements.join('\n'), /b\(\)/);
});
