// PRISM structural metrics + obfuscator-family fingerprinting. Universal heuristics.
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { lex, T } from '../lexer.js';

export interface Metrics {
  bytes: number;
  lines: number;
  tokens: number;
  nodes: number;
  functions: number;
  strings: number;
  numbers: number;
  maxDepth: number;
  whileTrue: number;        // `while true do` loops (VM trampolines / dispatch)
  longBrackets: number;     // [[..]] / [==[..]]
  gotos: number;
  // lexical tells
  underscoreNumbers: number;
  binaryLiterals: number;
  dupParamFns: number;
  tableReturnHead: boolean; // `return({...})` head (Luraph-style)
}

export interface FamilyGuess { family: string; confidence: number; reasons: string[]; }

export function computeMetrics(src: string, chunk: A.Chunk): Metrics {
  const { tokens } = lex(src);
  let nodes = 0, functions = 0, strings = 0, numbers = 0, whileTrue = 0, gotos = 0;
  walk(chunk, (n) => {
    nodes++;
    if (n.type === 'FunctionExpr') functions++;
    else if (n.type === 'StringLit') strings++;
    else if (n.type === 'NumberLit') numbers++;
    else if (n.type === 'GotoStat') gotos++;
    else if (n.type === 'WhileStat' && n.cond?.type === 'TrueLit') whileTrue++;
  });
  // token-level tells
  let underscoreNumbers = 0, binaryLiterals = 0, longBrackets = 0;
  for (const t of tokens) {
    if (t.type === T.Number) {
      if (t.value.includes('_')) underscoreNumbers++;
      if (/^0[bB]/.test(t.value)) binaryLiterals++;
    } else if (t.type === T.String && t.value.startsWith('[')) longBrackets++;
  }
  // duplicate-parameter functions (function(J,J))
  let dupParamFns = 0;
  walk(chunk, (n) => {
    if (n.type === 'FunctionExpr') { const s = new Set(); for (const p of n.params) { if (s.has(p)) { dupParamFns++; break; } s.add(p); } }
  });
  const maxDepth = depth(chunk);
  const tableReturnHead = chunk.body.length > 0 && chunk.body[chunk.body.length - 1]?.type === 'ReturnStat' &&
    hasTableReturn(chunk);
  return {
    bytes: src.length, lines: src.split('\n').length, tokens: tokens.length, nodes,
    functions, strings, numbers, maxDepth, whileTrue, longBrackets, gotos,
    underscoreNumbers, binaryLiterals, dupParamFns, tableReturnHead,
  };
}

function hasTableReturn(chunk: A.Chunk): boolean {
  for (const s of chunk.body) {
    if (s.type === 'ReturnStat' && s.args[0]) {
      let a: any = s.args[0];
      if (a.type === 'ParenExpr') a = a.expr;
      if (a.type === 'TableExpr') return true;
    }
  }
  return false;
}

function depth(chunk: A.Chunk): number {
  let max = 0;
  (function rec(body: A.Stat[], d: number) {
    if (d > max) max = d;
    for (const s of body) for (const b of kids(s)) rec(b, d + 1);
  })(chunk.body, 0);
  return max;
}
function kids(s: A.Stat): A.Stat[][] {
  switch (s.type) {
    case 'DoStat': case 'WhileStat': case 'RepeatStat': case 'NumericForStat': case 'GenericForStat': return [s.body];
    case 'IfStat': return [...s.clauses.map(c => c.body), ...(s.elseBody ? [s.elseBody] : [])];
    case 'FunctionStat': return [s.func.body];
    case 'LocalFunctionStat': return [s.func.body];
    default: return [];
  }
}

// Family fingerprinting: header comments + structural signatures.
export function fingerprint(src: string, m: Metrics): FamilyGuess[] {
  const guesses: FamilyGuess[] = [];
  const head = src.slice(0, 6000);
  const add = (family: string, confidence: number, reasons: string[]) => guesses.push({ family, confidence, reasons });

  // explicit header banners
  if (/Luraph Obfuscator/i.test(head)) add('Luraph', 0.99, ['header banner "Luraph Obfuscator"']);
  if (/MoonSec/i.test(head)) add('MoonSec', 0.97, ['header banner "MoonSec"']);
  if (/Prometheus/i.test(head)) add('Prometheus', 0.95, ['header banner "Prometheus"']);
  if (/wearedevs\.net\/obfuscator/i.test(head)) add('Prometheus (WeAreDevs rebrand)', 0.97, ['banner "wearedevs.net/obfuscator" (ships the Prometheus VM)']);
  if (/IronBrew/i.test(head)) add('IronBrew', 0.9, ['header banner "IronBrew"']);
  if (/Hercules/i.test(head)) add('Hercules', 0.9, ['header banner "Hercules"']);

  // Prometheus structural signature (no banner): return(function(...) local T = { "\ddd.." }
  const promHead = /return\s*\(\s*function\s*\(\s*\.\.\.\s*\)\s*local\s+[A-Za-z_]\w*\s*=\s*\{\s*"(?:\\\d{2,3})/.test(src.slice(0, 400));
  if (promHead && !guesses.some(g => g.family.startsWith('Prometheus')))
    add('Prometheus', 0.85, ['return(function(...) local T={"\\ddd.."} head', 'decimal-escaped constant-pool string table']);

  // LuaObfuscator.com: sequential v0,v1,v2.. builtin aliases (+ optional ASCII banner)
  const h600 = src.slice(0, 1200);
  if (/local\s+v0\s*=\s*\w+[;\s]+local\s+v1\s*=\s*string\.byte/.test(h600) ||
      (/local\s+v\d+\s*=\s*string\.byte/.test(h600) && /\.\_{4}/.test(src.slice(0, 600))))
    add('LuaObfuscator.com', 0.9, ['sequential vN builtin aliases (local v0=..;local v1=string.byte)']);

  // IronBrew2: builtin-alias prologue string.byte/char/sub + table.concat + math.ldexp + getfenv shim
  if (/local\s+\w+\s*=\s*string\.byte\s*;\s*local\s+\w+\s*=\s*string\.char\s*;\s*local\s+\w+\s*=\s*string\.sub/.test(h600) &&
      /math\.ldexp/.test(h600) && /getfenv\s+or\s+function\s*\(\s*\)\s*return\s+_ENV/.test(h600) &&
      !guesses.some(g => g.family === 'LuaObfuscator.com'))
    add('IronBrew2', 0.85, ['builtin-alias prologue string.byte/char/sub', 'math.ldexp + getfenv shim (IB2 deserializer)']);

  // structural signatures (used when no banner)
  if (!guesses.length) {
    if (m.tableReturnHead && m.underscoreNumbers > 0 && m.binaryLiterals > 0)
      add('Luraph-like', 0.75, ['return({...}) head', 'underscore/binary numeric literals', 'Luau VM dialect']);
    if (m.whileTrue >= 1 && m.numbers > m.nodes * 0.2)
      add('VM-based (generic)', 0.6, [`${m.whileTrue} while-true dispatch loop(s)`, 'high numeric-literal density']);
    if (m.dupParamFns > 5)
      add('register-VM (dup-param handlers)', 0.6, [`${m.dupParamFns} functions with duplicate params`]);
    if (m.longBrackets > 0 && m.functions < 10 && m.bytes > 20000)
      add('bytecode-blob loader', 0.5, ['few functions + long-bracket blob + large size']);
  }
  guesses.sort((a, b) => b.confidence - a.confidence);
  return guesses;
}
