// PRISM Luau lexer — universal, spec-accurate, tolerant.
// Handles Luau extensions seen across all obfuscator families:
//   underscore digit groups (0X1__2, 1_000), binary 0B..,
//   escapes \z \xHH \ddd \u{...}, long strings [[ ]] / [==[ ]==],
//   string interpolation `...{expr}...`, compound assignments += -= .. etc.

export enum T {
  Name, Number, String, InterpString,
  Keyword, Punct, Eof,
}

export interface Token {
  type: T;
  value: string;      // raw lexeme (source text)
  // decoded value for strings/numbers when applicable:
  cooked?: string;    // decoded string contents
  num?: number;       // numeric value
  start: number;      // byte offset in source
  end: number;
  line: number;
  col: number;
  // interpolation: segments of a backtick string (strings + embedded expr source)
  parts?: Array<{ kind: 'str' | 'expr'; value: string }>;
  nl?: boolean;       // preceded by a newline (for ASI-like heuristics)
}

export const KEYWORDS = new Set([
  'and','break','do','else','elseif','end','false','for','function','goto','if','in',
  'local','nil','not','or','repeat','return','then','true','until','while',
  // Luau contextual keywords are treated as names by the parser, except `continue`
  // which we surface as a keyword for convenience; parser also accepts it as a name.
  'continue',
]);

// Multi-char punctuation, longest first.
const PUNCT3 = ['...', '//=', '..='];
const PUNCT2 = ['==','~=','<=','>=','..','::','->','+=','-=','*=','/=','%=','^=','//','<<','>>'];
const PUNCT1 = '+-*/%^#&~|<>=(){}[];:,.?';

export interface LexError { message: string; start: number; line: number; col: number; }

export interface LexResult { tokens: Token[]; errors: LexError[]; }


/** Convert a JS (UTF-16) string to a Lua byte string: every code unit of the
 *  result is a byte 0-255 (non-ASCII chars are UTF-8 encoded). Lua strings are
 *  byte strings, so cooked literal values use this representation. */
export function utf8Bytes(str: string): string {
  if (!/[^\x00-\x7f]/.test(str)) return str;
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out += ch;
    else if (cp < 0x800) out += String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out += String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out += String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

/** Inverse of utf8Bytes for display: decode a byte string as UTF-8 where valid. */
export function bytesToDisplay(bytes: string): string {
  if (!/[\x80-\xff]/.test(bytes)) return bytes;
  try {
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i) & 0xff;
    return new TextDecoder('utf-8', { fatal: true }).decode(arr);
  } catch { return bytes; }
}

export function lex(src: string): LexResult {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;
  let pendingNL = false;

  const col = () => i - lineStart + 1;
  const push = (t: Omit<Token, 'nl'>) => { tokens.push({ ...t, nl: pendingNL }); pendingNL = false; };
  const err = (message: string, start = i) =>
    errors.push({ message, start, line, col: start - lineStart + 1 });

  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isHex = (c: string) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  const isNameStart = (c: string) => c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c.charCodeAt(0) > 127;
  const isNameCont = (c: string) => isNameStart(c) || isDigit(c);

  function newline(c: string) {
    // handle \r\n and \n\r as one line break
    const next = src[i + 1];
    if ((c === '\r' && next === '\n') || (c === '\n' && next === '\r')) i++;
    i++;
    line++;
    lineStart = i;
    pendingNL = true;
  }

  // Long bracket: returns level if src[pos] starts [=*[ , else -1
  function longBracketLevel(pos: number): number {
    if (src[pos] !== '[') return -1;
    let p = pos + 1, eq = 0;
    while (src[p] === '=') { eq++; p++; }
    return src[p] === '[' ? eq : -1;
  }

  function readLongString(level: number): string {
    // assumes i points at opening '['
    i += 2 + level; // skip [==[
    // Luau: a newline immediately after the opening bracket is skipped
    if (src[i] === '\r' || src[i] === '\n') { const c = src[i]; newline(c); }
    const close = ']' + '='.repeat(level) + ']';
    const startContent = i;
    const idx = src.indexOf(close, i);
    if (idx === -1) {
      err('unterminated long string');
      const rest = src.slice(startContent);
      i = n;
      return rest;
    }
    const content = src.slice(startContent, idx);
    // advance line counter across the content
    for (let k = startContent; k < idx; k++) {
      if (src[k] === '\n') { line++; lineStart = k + 1; }
    }
    i = idx + close.length;
    return content;
  }

  function readNumber() {
    const start = i;
    let isFloat = false;
    if (src[i] === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
      i += 2;
      while (i < n && (isHex(src[i]) || src[i] === '_')) i++;
      if (src[i] === '.') { isFloat = true; i++; while (i < n && (isHex(src[i]) || src[i] === '_')) i++; }
      if (src[i] === 'p' || src[i] === 'P') { isFloat = true; i++; if (src[i] === '+' || src[i] === '-') i++; while (i < n && (isDigit(src[i]) || src[i] === '_')) i++; }
    } else if (src[i] === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
      i += 2;
      while (i < n && (src[i] === '0' || src[i] === '1' || src[i] === '_')) i++;
    } else {
      while (i < n && (isDigit(src[i]) || src[i] === '_')) i++;
      if (src[i] === '.') { isFloat = true; i++; while (i < n && (isDigit(src[i]) || src[i] === '_')) i++; }
      if (src[i] === 'e' || src[i] === 'E') { isFloat = true; i++; if (src[i] === '+' || src[i] === '-') i++; while (i < n && (isDigit(src[i]) || src[i] === '_')) i++; }
    }
    const raw = src.slice(start, i);
    const num = decodeNumber(raw);
    push({ type: T.Number, value: raw, num, start, end: i, line, col: start - lineStart + 1 });
  }

  function readQuoted(q: string) {
    const start = i;
    i++; // opening quote
    let out = '';
    while (i < n) {
      const c = src[i];
      if (c === q) { i++; break; }
      if (c === '\n' || c === '\r') { err('unterminated string'); break; }
      if (c === '\\') { out += readEscape(); continue; }
      const code = c.charCodeAt(0);
      if (code > 127) {
        const w = code >= 0xd800 && code < 0xdc00 && i + 1 < n ? 2 : 1; // keep surrogate pairs together
        out += utf8Bytes(src.slice(i, i + w)); i += w; continue;
      }
      out += c; i++;
    }
    push({ type: T.String, value: src.slice(start, i), cooked: out, start, end: i, line, col: start - lineStart + 1 });
  }

  function readEscape(): string {
    // src[i] === '\\'
    i++;
    const c = src[i];
    switch (c) {
      case 'n': i++; return '\n';
      case 't': i++; return '\t';
      case 'r': i++; return '\r';
      case 'a': i++; return '\x07';
      case 'b': i++; return '\b';
      case 'f': i++; return '\f';
      case 'v': i++; return '\v';
      case '\\': i++; return '\\';
      case '"': i++; return '"';
      case "'": i++; return "'";
      case '`': i++; return '`';
      case '\n': case '\r': newline(c); return '\n';
      case 'x': {
        i++; let h = '';
        for (let k = 0; k < 2 && isHex(src[i]); k++) { h += src[i]; i++; }
        return h ? String.fromCharCode(parseInt(h, 16)) : 'x';
      }
      case 'z': {
        i++;
        while (i < n && /\s/.test(src[i])) { if (src[i] === '\n' || src[i] === '\r') newline(src[i]); else i++; }
        return '';
      }
      case 'u': {
        i++;
        if (src[i] === '{') {
          i++; let h = '';
          while (i < n && src[i] !== '}') { h += src[i]; i++; }
          if (src[i] === '}') i++;
          try { return utf8Bytes(String.fromCodePoint(parseInt(h, 16) || 0)); } catch { return ''; }
        }
        return 'u';
      }
      default:
        if (isDigit(c)) {
          let d = '';
          for (let k = 0; k < 3 && isDigit(src[i]); k++) { d += src[i]; i++; }
          return String.fromCharCode(parseInt(d, 10) & 0xff);
        }
        i++; return c ?? '';
    }
  }

  function readInterp() {
    // backtick string with {expr} segments
    const start = i;
    i++; // opening `
    const parts: Array<{ kind: 'str' | 'expr'; value: string }> = [];
    let cur = '';
    while (i < n) {
      const c = src[i];
      if (c === '`') { i++; break; }
      if (c === '\\') { cur += readEscape(); continue; }
      if (c === '{') {
        parts.push({ kind: 'str', value: cur }); cur = '';
        i++; // skip {
        let depth = 1; const estart = i;
        while (i < n && depth > 0) {
          const d = src[i];
          if (d === '{') depth++;
          else if (d === '}') { depth--; if (depth === 0) break; }
          else if (d === '"' || d === "'") { skipQuotedRaw(d); continue; }
          i++;
        }
        parts.push({ kind: 'expr', value: src.slice(estart, i) });
        if (src[i] === '}') i++;
        continue;
      }
      if (c === '\n' || c === '\r') { err('unterminated interpolated string'); break; }
      cur += c; i++;
    }
    parts.push({ kind: 'str', value: cur });
    push({ type: T.InterpString, value: src.slice(start, i), parts, start, end: i, line, col: start - lineStart + 1 });
  }

  function skipQuotedRaw(q: string) {
    i++; // opening
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === q) { i++; break; }
      if (c === '\n') break;
      i++;
    }
  }

  while (i < n) {
    const c = src[i];
    // whitespace
    if (c === '\n' || c === '\r') { newline(c); continue; }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') { i++; continue; }
    // comments
    if (c === '-' && src[i + 1] === '-') {
      i += 2;
      const lvl = longBracketLevel(i);
      if (lvl >= 0) { readLongString(lvl); continue; }
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    // long string
    const lvl = longBracketLevel(i);
    if (lvl >= 0) {
      const startL = i, lc = i - lineStart + 1, ln = line;
      const content = readLongString(lvl);
      push({ type: T.String, value: src.slice(startL, i), cooked: utf8Bytes(content), start: startL, end: i, line: ln, col: lc });
      continue;
    }
    // strings
    if (c === '"' || c === "'") { readQuoted(c); continue; }
    if (c === '`') { readInterp(); continue; }
    // numbers
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) { readNumber(); continue; }
    // names / keywords
    if (isNameStart(c)) {
      const start = i;
      i++;
      while (i < n && isNameCont(src[i])) i++;
      const value = src.slice(start, i);
      push({ type: KEYWORDS.has(value) ? T.Keyword : T.Name, value, start, end: i, line, col: start - lineStart + 1 });
      continue;
    }
    // punctuation (longest match)
    const three = src.substr(i, 3);
    if (PUNCT3.includes(three)) { const s = i; i += 3; push({ type: T.Punct, value: three, start: s, end: i, line, col: s - lineStart + 1 }); continue; }
    const two = src.substr(i, 2);
    if (PUNCT2.includes(two)) { const s = i; i += 2; push({ type: T.Punct, value: two, start: s, end: i, line, col: s - lineStart + 1 }); continue; }
    if (PUNCT1.includes(c)) { const s = i; i += 1; push({ type: T.Punct, value: c, start: s, end: i, line, col: s - lineStart + 1 }); continue; }

    err(`unexpected character ${JSON.stringify(c)}`);
    i++;
  }
  push({ type: T.Eof, value: '', start: i, end: i, line, col: col() });
  return { tokens, errors };
}

// Decode a Luau numeric literal (strips underscores, supports hex/bin/float/exp).
export function decodeNumber(raw: string): number {
  const s = raw.replace(/_/g, '');
  if (/^0[xX]/.test(s)) {
    if (/[.pP]/.test(s)) return parseHexFloat(s);
    return parseInt(s.slice(2), 16);
  }
  if (/^0[bB]/.test(s)) return parseInt(s.slice(2), 2) >>> 0;
  return parseFloat(s);
}

function parseHexFloat(s: string): number {
  // 0x<mantissa>[.<frac>][pP<exp>]
  const m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/.exec(s);
  if (!m) return NaN;
  const [, int = '', frac = '', exp = '0'] = m;
  let val = parseInt(int || '0', 16);
  if (frac) {
    let scale = 1;
    for (const ch of frac) { scale /= 16; val += parseInt(ch, 16) * scale; }
  }
  return val * Math.pow(2, parseInt(exp, 10));
}
