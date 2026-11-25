/// <reference lib="webworker" />
// PRISM engine worker — every static analysis runs here, off the main thread, fully offline.
import {
  analyze, clean, tokenize, mapOpcodes, formatOpcodeTree, opmapFromTree, constants, searchPattern, xrefs, getFunction,
  luaToPython, functionToPython, renameSymbols, simplifyExpression, findEmbeddedBytecode, disassembleBytecode,
  vmDisassemble, luaLiteralToJson, lex, T, Blob, anatomy, formatAnatomy, chunkDisassemble, inlineValues,
  behaviorReport, formatBehavior, collectJsonStrings, functionToLua, decodeBundle,
} from '@prism/core';

type Req = { id: number; op: string; src: string; opts?: any };

function findText(src: string, o: { query: string; regex?: boolean; caseSensitive?: boolean; word?: boolean; max?: number }) {
  const lines = src.split('\n');
  const max = o.max ?? 2000;
  let re: RegExp;
  const flags = o.caseSensitive ? 'g' : 'gi';
  if (o.regex) re = new RegExp(o.query, flags);
  else { const e = o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); re = new RegExp(o.word ? `(?<![A-Za-z0-9_])${e}(?![A-Za-z0-9_])` : e, flags); }
  const hits: Array<{ line: number; col: number; text: string; match: string }> = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i]))) {
      total++;
      if (hits.length < max) {
        const s = Math.max(0, m.index - 60);
        hits.push({ line: i + 1, col: m.index + 1, text: (s > 0 ? '…' : '') + lines[i].slice(s, m.index + m[0].length + 100), match: m[0] });
      }
      if (!m[0].length) re.lastIndex++;
    }
  }
  return { hits, total };
}

function stringLiterals(src: string, line: number) {
  const { tokens } = lex(src);
  return tokens.filter(t => t.line === line && T_STRING.has(t.type)).map(t => ({ col: t.col, len: t.cooked?.length ?? 0, cooked: t.cooked ?? '' }));
}
const T_STRING = new Set<number>([T.String]);

function blobInfo(b: Uint8Array) {
  return { length: b.length, entropy: Blob.entropyBytes(b), printable: Blob.printableBytes(b), magic: Blob.detectMagic(b), hexdump: Blob.hexdump(b, 8192) };
}

const ZLIB: Record<string, CompressionFormat> = { inflate: 'deflate', gunzip: 'gzip', 'inflate-raw': 'deflate-raw' };
async function decompress(b: Uint8Array, fmt: CompressionFormat): Promise<Uint8Array> {
  const ds = new DecompressionStream(fmt);
  const stream = new globalThis.Blob([b as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function runBlobAsync(input: Uint8Array, steps: Array<{ op: string; arg?: string }>) {
  let cur = input; const trace: Array<{ op: string; len: number; error?: string }> = [];
  for (const st of steps) {
    try {
      if (ZLIB[st.op]) cur = await decompress(cur, ZLIB[st.op]);
      else { const r = Blob.runBlob(cur, [st]); if (r.trace[0]?.error) { trace.push(r.trace[0]); break; } cur = r.out; }
      trace.push({ op: st.op, len: cur.length });
    } catch (err: any) { trace.push({ op: st.op, len: cur.length, error: String(err?.message ?? err) }); break; }
  }
  return { out: cur, trace, info: blobInfo(cur) };
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, op, src, opts = {} } = e.data;
  const t0 = performance.now();
  try {
    let result: any;
    switch (op) {
      case 'analyze': result = analyze(src); break;
      case 'clean': result = clean(src, opts); break;
      case 'tokenize': result = tokenize(src); break;
      case 'full': result = { report: analyze(src), clean: clean(src, opts ?? { rounds: 4 }) }; break;
      case 'opcodes': {
        const r = mapOpcodes(src, { clean: false, maxTrees: opts.maxTrees ?? 8, minLeaves: opts.minLeaves });
        result = { report: r.report, opmaps: r.report.trees.map(t => opmapFromTree(t)), texts: r.report.trees.map(t => formatOpcodeTree(t, { lifted: true })) };
        break;
      }
      case 'constants': result = constants(src, opts); break;
      case 'find': result = findText(src, opts); break;
      case 'pattern': result = searchPattern(src, opts.pattern, { max: opts.max ?? 500, kind: opts.kind }); break;
      case 'xrefs': result = xrefs(src, opts.name, { line: opts.line || undefined, max: opts.max }); break;
      case 'getFunction': result = getFunction(src, opts.query); break;
      case 'python': result = opts.fn !== undefined && opts.fn !== '' ? functionToPython(src, opts.fn, { prelude: opts.prelude, maxCalls: opts.maxCalls }) : luaToPython(src, { prelude: opts.prelude }); break;
      case 'rename': result = renameSymbols(src, opts.renames); break;
      case 'simplify': result = simplifyExpression(opts.expr, opts.clean ?? {}); break;
      case 'embedded': result = findEmbeddedBytecode(src, { max: opts.max ?? 50 }); break;
      case 'disasm': result = disassembleBytecode(opts.bytes as Uint8Array, opts.options ?? {}); break;
      case 'blob': result = await runBlobAsync(opts.bytes as Uint8Array, opts.steps ?? []); break;
      case 'blobAutoZ': {
        // auto-decode + zlib attempts on the raw input and on each candidate
        const base = Blob.autoDecode(opts.bytes as Uint8Array);
        const extra: typeof base = [];
        for (const c of [{ steps: [] as Array<{ op: string; arg?: string }> }, ...base.slice(0, 4)]) {
          for (const z of Object.keys(ZLIB)) {
            const r = await runBlobAsync(opts.bytes as Uint8Array, [...c.steps, { op: z }]);
            if (!r.trace.some(t => t.error) && r.out.length) extra.push({ steps: [...c.steps, { op: z }], len: r.out.length, printable: r.info.printable, entropy: r.info.entropy, magic: r.info.magic, preview: Blob.unlatin1(r.out.subarray(0, 80)).replace(/[^\x20-\x7e]/g, '.') });
          }
        }
        result = [...extra, ...base];
        break;
      }
      case 'blobAuto': result = Blob.autoDecode(opts.bytes as Uint8Array); break;
      case 'xor': {
        const b = opts.bytes as Uint8Array;
        result = { single: Blob.xorSingleCandidates(b, 8), lengths: Blob.xorKeyLengths(b, 32).slice(0, 8), known: opts.plain ? Array.from(Blob.xorKnownPlaintext(b, Blob.latin1(opts.plain), opts.offset ?? 0)) : null };
        break;
      }
      case 'vmdisasm': result = vmDisassemble(opts.instructions, opts.opmap ?? {}, opts.options ?? {}); break;
      case 'literal': result = luaLiteralToJson(opts.text); break;
      case 'stringsOnLine': result = stringLiterals(src, opts.line); break;
      case 'parseBytes': result = Blob.parseBytes(opts.data, opts.encoding ?? 'auto'); break;
      case 'embeddedBytes': {
        // re-derive the bytes of an embedded-bytecode hit (line + via)
        for (const t of stringLiterals(src, opts.line)) {
          const v = t.cooked; let b: Uint8Array | null = null;
          try { b = opts.via === 'base64' ? Blob.b64decode(v.replace(/\s+/g, '')) : opts.via === 'hex' ? Blob.hexdecode(v) : Blob.latin1(v); } catch { b = null; }
          if (b && b.length === opts.length) { result = b; break; }
        }
        if (!result) throw new Error('embedded bytecode literal not found on line ' + opts.line);
        break;
      }
      case 'chunkdisasm': {
        let json = opts.chunk;
        if (typeof json === 'string') { const t = json.trim(); try { json = JSON.parse(t); } catch { json = luaLiteralToJson(t); } }
        const r = chunkDisassemble(json, opts.opmap ?? {}, opts.options ?? {});
        result = { ...r, strings: r.strings.slice(0, 5000) };
        break;
      }
      case 'inline': {
        let values = opts.values;
        if (typeof values === 'string') values = JSON.parse(values);
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('expected a JSON object keyed by call site, e.g. {"L12:5": "decoded"}');
        result = inlineValues(src, values, opts.options ?? {});
        if (opts.reclean) result = { ...result, code: clean(result.code, { rename: 'none' }).code };
        break;
      }
      case 'bundle': result = decodeBundle(src, opts.functions?.length ? opts.functions : 'auto', { lang: opts.lang, maxCalls: opts.maxCalls, maxDecoders: opts.maxDecoders, label: opts.label }); break;
      case 'luaslice': result = functionToLua(src, opts.fn, { prelude: opts.prelude, maxCalls: opts.maxCalls }); break;
      case 'behavior': {
        const strings: Array<{ value: string; where?: string }> = [...(opts.strings ?? [])];
        if (opts.chunk !== undefined) { let json = opts.chunk; if (typeof json === 'string') { const t = json.trim(); try { json = JSON.parse(t); } catch { json = luaLiteralToJson(t); } } strings.push(...collectJsonStrings(json)); }
        const r = behaviorReport({ src: opts.noSource ? undefined : src, strings: strings.length ? strings : undefined }, { maxHits: opts.maxHits ?? 30 });
        result = { report: r, text: formatBehavior(r, { label: opts.label }) };
        break;
      }
      case 'anatomy': { const a = anatomy(src, { maxChunks: opts.maxChunks ?? 60 }); delete (a as any).code; result = { anatomy: a, text: formatAnatomy(a, { maxChunks: 40 }) }; break; }
      case 'literalBytes': { const lits = stringLiterals(src, opts.line); const t = opts.largest ? [...lits].sort((x, y) => y.len - x.len)[0] : lits[opts.index ?? 0] ?? lits[0]; if (!t) throw new Error('no string literal on line ' + opts.line); result = Blob.latin1(t.cooked); break; }
      default: throw new Error('unknown op ' + op);
    }
    (self as any).postMessage({ id, ok: true, result, ms: Math.round(performance.now() - t0) });
  } catch (err: any) {
    (self as any).postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
