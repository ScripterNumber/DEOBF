// Scope-aware manual renaming that PRESERVES the original formatting: every reference and the
// declaring identifier of the chosen binding(s) are rewritten in place by source offset.
import { lex, T, Token } from '../lexer.js';
import { parse } from '../parser.js';
import { analyzeScopes, Binding } from '../analysis/scope.js';

export interface RenameRequest { name: string; to: string; line?: number; all?: boolean }
export interface RenameApplied { name: string; to: string; line: number; kind: string; sites: number }
export interface RenameSymbolsResult { code: string; applied: RenameApplied[]; errors: string[]; warnings: string[] }

const KW = new Set('and break do else elseif end false for function if in local nil not or repeat return then true until while goto continue'.split(' '));
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function renameSymbols(src: string, requests: RenameRequest[]): RenameSymbolsResult {
  const { chunk } = parse(src);
  const { tokens } = lex(src);
  const scope = analyzeScopes(chunk);
  const errors: string[] = [], warnings: string[] = [], applied: RenameApplied[] = [];
  const edits = new Map<number, { end: number; to: string }>();
  // token index by start offset
  const byStart = new Map<number, number>(); tokens.forEach((t, i) => byStart.set(t.start, i));
  const firstTokAt = (pos: number) => { let i = byStart.get(pos); if (i !== undefined) return i; i = tokens.findIndex(t => t.start >= pos); return i < 0 ? tokens.length : i; };
  const isP = (t: Token | undefined, v: string) => !!t && t.type !== T.String && t.type !== T.Number && t.value === v;
  /** names in a declaration list starting at token i (skips `: type` and `<attrib>`), until a stop token */
  const declNames = (i: number, stops: string[]): Token[] => {
    const out: Token[] = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === T.Name && !KW.has(t.value)) out.push(t); else break;
      i++;
      if (isP(tokens[i], '<')) { while (i < tokens.length && !isP(tokens[i], '>')) i++; i++; }
      if (isP(tokens[i], ':')) { let depth = 0; i++; while (i < tokens.length) { const u = tokens[i]; if (depth === 0 && (isP(u, ',') || stops.some(s => isP(u, s)))) break; if (isP(u, '(') || isP(u, '{') || isP(u, '[') || isP(u, '<')) depth++; if (isP(u, ')') || isP(u, '}') || isP(u, ']') || isP(u, '>')) depth--; i++; } }
      if (isP(tokens[i], ',')) { i++; continue; }
      break;
    }
    return out;
  };
  const declToken = (b: Binding): Token | null => {
    const d = b.decl; if (!d?.loc) return null;
    let i = firstTokAt(d.loc.start);
    switch (d.type) {
      case 'LocalStat': if (isP(tokens[i], 'local')) i++; return declNames(i, ['=', ';'])[b.index] ?? null;
      case 'LocalFunctionStat': { while (i < tokens.length && !isP(tokens[i], 'function')) i++; const t = tokens[i + 1]; return t?.type === T.Name ? t : null; }
      case 'FunctionExpr': { while (i < tokens.length && !isP(tokens[i], '(')) i++; return declNames(i + 1, [')'])[b.index] ?? null; }
      case 'NumericForStat': { if (isP(tokens[i], 'for')) i++; const t = tokens[i]; return t?.type === T.Name ? t : null; }
      case 'GenericForStat': { if (isP(tokens[i], 'for')) i++; return declNames(i, ['in'])[b.index] ?? null; }
    }
    return null;
  };
  for (const r of requests) {
    if (!IDENT.test(r.to) || KW.has(r.to)) { errors.push(`"${r.to}" is not a valid identifier`); continue; }
    let cands = scope.bindings.filter(b => b.kind !== 'global' && b.name === r.name);
    if (r.line !== undefined) {
      const exact = cands.filter(b => b.line === r.line);
      cands = exact.length ? exact : cands.filter(b => b.refs.some(x => x.loc?.line === r.line));
    }
    if (!cands.length) { errors.push(`no local binding named "${r.name}"${r.line !== undefined ? ` declared/used at line ${r.line}` : ''}`); continue; }
    if (cands.length > 1 && !r.all) { errors.push(`"${r.name}" is ambiguous — ${cands.length} bindings (declared at lines ${cands.map(b => b.line).join(', ')}); pass line or all=true`); continue; }
    const clash = scope.bindings.filter(b => b.name === r.to).length + (scope.globals.has(r.to) ? 1 : 0);
    if (clash) warnings.push(`"${r.to}" already names ${clash} other binding(s)/global — check for shadowing`);
    for (const b of cands) {
      let sites = 0;
      const dt = declToken(b);
      if (dt) { edits.set(dt.start, { end: dt.end, to: r.to }); sites++; } else warnings.push(`could not locate the declaration of "${r.name}" (line ${b.line}); only references renamed`);
      for (const ref of b.refs) if (ref.loc) { edits.set(ref.loc.start, { end: ref.loc.start + b.name.length, to: r.to }); sites++; }
      applied.push({ name: r.name, to: r.to, line: b.line, kind: b.kind, sites });
    }
  }
  let code = src;
  for (const [start, e] of [...edits].sort((x, y) => y[0] - x[0])) code = code.slice(0, start) + e.to + code.slice(e.end);
  return { code, applied, errors, warnings };
}
