import { lex, T } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { walk } from '../src/ast.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'apps/web/public/samples');
const files = readdirSync(dir).filter(f => f.endsWith('.lua')).sort();
let totalTok = 0, totalNodes = 0, totalErr = 0, ok = 0;
console.log(`Testing lexer+parser on ${files.length} real fixtures:\n`);
for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8');
  const t0 = Date.now();
  const lr = lex(src);
  const t1 = Date.now();
  const pr = parse(src);
  const t2 = Date.now();
  let nodes = 0; walk(pr.chunk, () => nodes++);
  totalTok += lr.tokens.length; totalNodes += nodes; totalErr += pr.errors.length;
  const errRatio = pr.errors.length / Math.max(1, nodes);
  const good = errRatio < 0.01;
  if (good) ok++;
  const firstErr = pr.errors[0] ? ` | 1st: "${pr.errors[0].message}" @L${pr.errors[0].line}` : '';
  console.log(
    `${good ? 'OK ' : 'ERR'} ${f.padEnd(26)} ${(src.length/1024|0)+'KB'}`.padEnd(44) +
    `tok=${lr.tokens.length.toString().padStart(7)} nodes=${nodes.toString().padStart(7)} ` +
    `perr=${pr.errors.length.toString().padStart(4)} lex=${(t1-t0)}ms parse=${(t2-t1)}ms${firstErr}`
  );
}
console.log(`\n${ok}/${files.length} parsed clean (<1% error ratio). tokens=${totalTok} nodes=${totalNodes} parseErrors=${totalErr}`);
