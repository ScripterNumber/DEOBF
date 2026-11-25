// PRISM decode bundle — every decoder of a script in ONE program that prints ONE JSON object for ALL their call sites.
// Python: each decoder port runs in its own namespace on top of one shared Lua-semantics prelude.
// Lua: each exact slice lives in its own do … end block on top of one shared compat + harness.
// The user runs it once (`python3 bundle.py out.json` / `luau bundle.lua > out.json`), inline_values consumes the result.
// PRISM generates it statically; it never runs it.
import { parse } from '../parser.js';
import { findConstants } from '../analysis/constants.js';
import { functionToPython } from './python.js';
import { PY_PRELUDE } from './pyprelude.js';
import { functionToLua, LUA_COMPAT, LUA_HARNESS, LUA_OUTPUT } from './luaslice.js';

export interface BundlePart { query: string | number; name: string; line: number; kind?: string; sites: number; deps: string[]; freeNames: string[]; error?: string }
export interface BundleResult { code: string; lang: 'python' | 'lua'; parts: BundlePart[]; sites: number; warnings: string[] }
export interface BundleOptions { lang?: 'python' | 'lua'; maxCalls?: number; maxDecoders?: number; label?: string }

/** Decoder candidates worth evaluating: functions called with literal arguments, most call sites first. */
export function pickDecoders(src: string, max = 6): Array<{ line: number; name: string; kind: string; literalArgCalls: number }> {
  const rep = findConstants(parse(src).chunk, { maxDecoders: 40, maxStrings: 0, maxNumbers: 0, maxArrays: 0 });
  const seen = new Set<number>();
  return (rep.decoders ?? []).filter(d => d.literalArgCalls > 0 && d.endLine > 0 && !seen.has(d.line) && (seen.add(d.line), true))
    .sort((a, b) => b.literalArgCalls - a.literalArgCalls).slice(0, max)
    .map(d => ({ line: d.line, name: d.name, kind: d.kind, literalArgCalls: d.literalArgCalls }));
}

const pyStr = (s: string) => JSON.stringify(s); // a JSON string literal is a valid Python 3 str literal

export function decodeBundle(src: string, targets: Array<string | number> | 'auto', opts: BundleOptions = {}): BundleResult {
  const lang = opts.lang ?? 'python';
  const maxCalls = opts.maxCalls ?? 1000;
  const picked = targets === 'auto' ? pickDecoders(src, opts.maxDecoders ?? 6) : targets.map(q => ({ line: typeof q === 'number' ? q : NaN, name: String(q), kind: '', literalArgCalls: 0, q }));
  const parts: BundlePart[] = [];
  const warnings: string[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const p of picked) {
    const q: string | number = (p as { q?: string | number }).q ?? p.line;
    if (lang === 'python') {
      const r = functionToPython(src, q, { prelude: false, maxCalls });
      if (!r) { parts.push({ query: q, name: String(q), line: 0, sites: 0, deps: [], freeNames: [], error: 'no function matches' }); continue; }
      if (seen.has(r.name + '@' + r.line)) continue; seen.add(r.name + '@' + r.line);
      const keys = [...r.code.matchAll(/_site\((\[[^\]]*\])/g)].reduce((n, m) => n + (JSON.parse(m[1]) as string[]).length, 0);
      parts.push({ query: q, name: r.name, line: r.line, kind: p.kind, sites: keys, deps: r.deps, freeNames: r.freeNames });
      r.warnings.forEach(w => warnings.push(`${r.name} L${r.line}: ${w}`));
      blocks.push(`    (${pyStr(`${r.name} L${r.line}`)}, ${pyStr(r.code)}),`);
    } else {
      const r = functionToLua(src, q, { prelude: false, maxCalls });
      if (!r) { parts.push({ query: q, name: String(q), line: 0, sites: 0, deps: [], freeNames: [], error: 'no function matches' }); continue; }
      if (seen.has(r.name + '@' + r.line)) continue; seen.add(r.name + '@' + r.line);
      parts.push({ query: q, name: r.name, line: r.line, kind: p.kind, sites: r.sites, deps: r.deps, freeNames: r.freeNames });
      r.warnings.forEach(w => warnings.push(`${r.name} L${r.line}: ${w}`));
      blocks.push(`do -- ==== [${parts.length}] ${r.name} (L${r.line})${p.kind ? ' · ' + p.kind : ''} — ${r.sites} call site(s) ====\n${r.body}\n${r.calls.join('\n')}\nend\n`);
    }
  }
  const ok = parts.filter(p => !p.error);
  const total = ok.reduce((n, p) => n + p.sites, 0);
  const list = ok.map((p, i) => `[${i + 1}] ${p.name} L${p.line}${p.kind ? ' ' + p.kind : ''}: ${p.sites} call site(s)`);
  let code: string;
  if (lang === 'python') {
    code = [`#!/usr/bin/env python3`,
      `# PRISM decode bundle${opts.label ? ' — ' + opts.label : ''}: ${ok.length} decoder(s), ${total} call site(s), ONE JSON object for all of them.`,
      ...list.map(l => '#   ' + l),
      `# Run:  python3 bundle.py out.json   → then inline_values {values_path:"out.json"} on the SAME script (or Python → Results → Lua).`,
      `# Generated statically by PRISM; PRISM never executes it.`, '', PY_PRELUDE, '',
      'import sys as _sys',
      '_PROGRAMS = [', ...blocks, ']', '',
      'def _run_all(out_path=None):',
      '    merged = {}',
      '    base = dict(globals())',
      '    for title, code in _PROGRAMS:',
      "        ns = dict(base)",
      "        ns['__name__'] = '__main__'",
      "        ns['lua_dump'] = lambda v, path=None, indent=1: None  # results are collected below",
      '        saved_argv, _sys.argv = _sys.argv, [title]',
      '        try:',
      "            exec(compile(code, title, 'exec'), ns)",
      "            sites = ns.get('_sites') or {}",
      '            merged.update(sites)',
      "            print('# %s: %d call-site value(s)' % (title, len(sites)), file=_sys.stderr)",
      '        except Exception as e:  # one broken decoder must not hide the others',
      "            print('# %s failed: %s: %s' % (title, type(e).__name__, e), file=_sys.stderr)",
      '        finally:',
      '            _sys.argv = saved_argv',
      '    lua_dump(merged, out_path)',
      '    if out_path:',
      "        print('saved %d call-site results to %s' % (len(merged), out_path))",
      '', '',
      "if __name__ == '__main__':",
      '    _run_all(_sys.argv[1] if len(_sys.argv) > 1 else None)', ''].join('\n');
  } else {
    code = [`-- PRISM decode bundle${opts.label ? ' — ' + opts.label : ''}: ${ok.length} decoder(s), ${total} call site(s), ONE JSON object for all of them.`,
      ...list.map(l => '--   ' + l),
      `-- Run:  lua5.1 bundle.lua out.json  |  luau bundle.lua > out.json   → then inline_values {values_path:"out.json"} on the SAME script.`,
      `-- Each decoder is the ORIGINAL code (exact slice) in its own do … end block. Generated statically; PRISM never executes it.`, '',
      LUA_COMPAT, LUA_HARNESS, ...blocks, LUA_OUTPUT].join('\n');
  }
  if (!ok.length) warnings.push('no decoder with literal-argument call sites found — pass functions explicitly (names or lines)');
  return { code, lang, parts, sites: total, warnings };
}
