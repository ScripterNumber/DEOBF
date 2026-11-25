import { analyze, clean } from '../src/index.js';
import { parse } from '../src/parser.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'apps/web/public/samples');
const files = readdirSync(dir).filter(f => f.endsWith('.lua')).sort();
console.log(`PRISM full-pipeline test on ${files.length} real fixtures:\n`);
let rtOk = 0;
for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8');
  const t0 = Date.now();
  const rep = analyze(src);
  const t1 = Date.now();
  const cl = clean(src, { rounds: 4 });
  const t2 = Date.now();
  // round-trip: cleaned output must re-parse with zero errors
  const rt = parse(cl.code);
  const rtClean = rt.errors.length === 0;
  if (rtClean) rtOk++;
  const fam = rep.families[0];
  const vm = rep.vm;
  const disp = vm.dispatchSummary.map(d => `${d.kind}×${d.count}`).join(' ') || '-';
  console.log(`${f}`);
  console.log(`  family=${fam ? fam.family+' ('+(fam.confidence*100|0)+'%)' : 'unknown'}  fns=${rep.callGraph.functionCount} edges=${rep.callGraph.edgeCount} strings=${rep.strings.total} aliases=${rep.aliases.length}`);
  console.log(`  vm: isVM=${vm.isVM} dispatch=[${disp}] trampolines=${vm.trampolines.length} blobs=${vm.blobs.length} opEst=${vm.opcodeEstimate ?? '-'} clusters=${vm.handlerClusters.length}`);
  console.log(`  clean: folded=${cl.stats.folded}(mba=${cl.stats.mbaFolded}) chars=${cl.stats.charCalls} concat=${cl.stats.concatChains} pruned=${cl.stats.prunedBranches} dead=${cl.stats.removedStmts} rounds=${cl.rounds}`);
  console.log(`  roundtrip-reparse: ${rtClean ? 'OK (0 errors)' : 'FAIL ('+rt.errors.length+' errors, 1st: '+(rt.errors[0]?.message)+' @L'+(rt.errors[0]?.line)+')'}  | analyze=${t1-t0}ms clean=${t2-t1}ms\n`);
}
console.log(`\nRound-trip valid: ${rtOk}/${files.length}`);
