// Semantic-equivalence harness (DEV ONLY): runs synthetic test programs through
// clean() with every option, then compares output of original vs cleaned using the
// stock Luau interpreter. Never used by the product, which stays static-only.
import { clean } from '../../src/index.ts';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const LUAU = process.env.LUAU_BIN ?? 'luau'; // stock Luau REPL (dev-only harness; set LUAU_BIN)
const dir = new URL('.', import.meta.url).pathname;
let fails = 0;
const run = (file: string) => { try { return execFileSync(LUAU, [file], { encoding: 'latin1' }); } catch (e: any) { return 'ERROR: ' + (e.stdout || '') + (e.stderr || ''); } };
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;   // optional subset: t3.lua,v1.lua
for (const f of readdirSync(dir).filter(f => /^[tv]\d+\.lua$/.test(f) && (!only || only.has(f)))) {
  const src = readFileSync(dir + f, 'utf8');
  const want = run(dir + f);
  // `-- prism: vm` tests: VM residual style (register promotion, multiple-results fusion with the PACK helper)
  const vm = /^-- prism: vm/.test(src);
  for (const mode of (vm ? ['vm', 'vm-renamed'] : ['none', 'obfuscated', 'all', 'unroll']) as Array<'none' | 'obfuscated' | 'all' | 'unroll' | 'vm' | 'vm-renamed'>) {
    const rename = mode === 'unroll' || mode === 'vm' ? 'none' : mode === 'vm-renamed' ? 'all' : mode;
    const r = vm
      ? clean(src, { rename, unrollFor: 8, rounds: 10, promoteRegisters: true, pureIndex: true, packHelper: (e) => e.type === 'NameExpr' && e.name === 'PACK' })
      : clean(src, { rename, unrollFor: mode === 'unroll' ? 8 : 0 });
    const out = '/tmp/prism_sem_' + mode + '_' + f;
    writeFileSync(out, r.code);
    const got = run(out);
    const ok = got === want;
    if (!ok) fails++;
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + f + ' mode=' + mode + ' ' + JSON.stringify(r.stats));
    if (!ok) { console.log('--- want\n' + want + '--- got\n' + got); }
  }
}
process.exit(fails ? 1 : 0);
