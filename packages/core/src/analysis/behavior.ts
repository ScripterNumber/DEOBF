// Behaviour / IOC report — "what does this script do?" from static evidence only:
// API names used as identifiers, method names or (decoded) string constants, plus URLs / webhooks / asset ids.
// Works on source text and/or a list of strings (e.g. the constants of a decoded VM chunk or inlined values). Nothing is executed.
import { lex, T } from '../lexer.js';
import { unbytes } from '../bytecode/chunk.js';

export interface BehaviorHit { indicator: string; line?: number; where?: string; text: string; }
export interface BehaviorCategory { id: string; title: string; severity: 'info' | 'notice' | 'warn' | 'high'; count: number; indicators: string[]; hits: BehaviorHit[]; }
export interface BehaviorReport { categories: BehaviorCategory[]; urls: Array<{ url: string; kind: string; line?: number; where?: string }>; verdict: string[]; scanned: { names: number; strings: number }; }

const RULES: Array<{ id: string; title: string; severity: BehaviorCategory['severity']; names: string[] }> = [
  { id: 'network', title: 'Network access', severity: 'warn', names: ['HttpGet', 'HttpGetAsync', 'HttpPost', 'HttpPostAsync', 'http_request', 'request', 'RequestAsync', 'GetAsync', 'PostAsync', 'HttpService', 'WebSocket', 'websocket', 'syn.request', 'fluxus.request', 'http.request'] },
  { id: 'loader', title: 'Remote / dynamic code loading', severity: 'warn', names: ['loadstring', 'load', 'dofile', 'loadfile', 'getscriptbytecode', 'decompile', 'require'] },
  { id: 'filesystem', title: 'Executor file system', severity: 'warn', names: ['writefile', 'readfile', 'appendfile', 'isfile', 'isfolder', 'makefolder', 'delfile', 'delfolder', 'listfiles', 'loadfile'] },
  { id: 'clipboard', title: 'Clipboard', severity: 'notice', names: ['setclipboard', 'toclipboard', 'getclipboard', 'set_clipboard', 'Clipboard'] },
  { id: 'identity', title: 'Identity / device fingerprinting', severity: 'high', names: ['gethwid', 'get_hwid', 'GetClientId', 'RbxAnalyticsService', 'HWID', 'hwid', 'GetCountryRegionForPlayerAsync', 'LocalizationService', 'MembershipType', 'AccountAge'] },
  { id: 'hooks', title: 'Hooks & metatable tampering', severity: 'warn', names: ['hookfunction', 'hookmetamethod', 'replaceclosure', 'detour_function', 'newcclosure', 'getrawmetatable', 'setrawmetatable', 'setreadonly', 'make_writeable', 'make_readonly', 'isreadonly', 'getnamecallmethod', 'setnamecallmethod', 'checkcaller', '__namecall'] },
  { id: 'executor', title: 'Executor environment / introspection', severity: 'notice', names: ['identifyexecutor', 'getexecutorname', 'getgenv', 'getrenv', 'getsenv', 'getreg', 'getgc', 'getinstances', 'getnilinstances', 'getconnections', 'getcallingscript', 'getupvalue', 'getupvalues', 'setupvalue', 'getconstant', 'getconstants', 'setconstant', 'getprotos', 'getproto', 'iscclosure', 'islclosure', 'cloneref', 'gethui', 'get_hidden_gui', 'sethiddenproperty', 'gethiddenproperty', 'setsimulationradius', 'queue_on_teleport', 'queueonteleport', 'syn', 'KRNL_LOADED', 'is_sirhurt_closure', 'pebc_execute', 'Drawing', 'firesignal', 'fireclickdetector', 'firetouchinterest', 'fireproximityprompt', 'getthreadidentity', 'setthreadidentity', 'getidentity', 'setidentity'] },
  { id: 'anti', title: 'Anti-tamper / anti-debug', severity: 'notice', names: ['getinfo', 'traceback', 'sethook', 'gethook', 'getfenv', 'setfenv', 'newproxy', 'dump', 'collectgarbage', 'getlocal', 'getregistry', 'islclosure'] },
  { id: 'remote', title: 'Game remotes & input automation', severity: 'notice', names: ['FireServer', 'InvokeServer', 'RemoteEvent', 'RemoteFunction', 'UnreliableRemoteEvent', 'VirtualInputManager', 'VirtualUser', 'SendKeyEvent', 'SendMouseButtonEvent', 'mouse1click', 'mouse1press', 'keypress', 'keyrelease', 'mousemoveabs', 'mousemoverel'] },
  { id: 'moderation', title: 'Kick / teleport / server hop', severity: 'notice', names: ['Kick', 'TeleportService', 'Teleport', 'TeleportToPlaceInstance', 'TeleportAsync', 'Shutdown'] },
  { id: 'ui', title: 'UI library / interface', severity: 'info', names: ['Rayfield', 'OrionLib', 'Orion', 'Kavo', 'Fluent', 'Linoria', 'WindUI', 'Venyx', 'ScreenGui', 'CoreGui', 'StarterGui', 'SetCore'] },
  { id: 'crypto', title: 'Crypto / encoding helpers', severity: 'info', names: ['base64encode', 'base64decode', 'base64_encode', 'base64_decode', 'crypt', 'lz4compress', 'lz4decompress', 'JSONEncode', 'JSONDecode', 'GenerateGUID'] },
];
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>\\`]{3,}/gi;
const ASSET_RE = /\brbxassetid:\/\/\d+|\brbxasset:\/\/[^\s"']+/gi;
function urlKind(u: string): string {
  const l = u.toLowerCase();
  if (/discord(app)?\.com\/api\/webhooks/.test(l)) return 'discord-webhook';
  if (/api\.telegram\.org\/bot/.test(l)) return 'telegram-bot';
  if (/webhook|hook\.(us|eu)\d?\.make\.com|pipedream|requestbin|beeceptor/.test(l)) return 'webhook';
  if (/discord\.gg\/|discord(app)?\.com\/invite/.test(l)) return 'discord-invite';
  if (/pastebin\.com|raw\.githubusercontent\.com|gist\.github|github\.com|gitlab\.com|pastefy|rentry\.co|hastebin|controlc\.com/.test(l)) return 'code-host';
  if (/ipify|ip-api\.com|ipinfo\.io|ifconfig|icanhazip|myip|geoip|ipapi/.test(l)) return 'ip-lookup';
  if (/roblox\.com|rbxcdn\.com|roproxy/.test(l)) return 'roblox';
  if (/grabify|iplogger|2no\.co|yip\.su|blasze/.test(l)) return 'ip-logger';
  return 'other';
}

export function behaviorReport(input: { src?: string; strings?: Array<{ value: string; where?: string }> }, opts: { maxHits?: number } = {}): BehaviorReport {
  const maxHits = opts.maxHits ?? 12;
  const byName = new Map<string, Array<{ id: string }>>();
  for (const r of RULES) for (const n of r.names) { const l = byName.get(n) ?? []; l.push({ id: r.id }); byName.set(n, l); }
  const cats = new Map<string, BehaviorCategory>();
  for (const r of RULES) cats.set(r.id, { id: r.id, title: r.title, severity: r.severity, count: 0, indicators: [], hits: [] });
  const urls = new Map<string, { url: string; kind: string; line?: number; where?: string }>();
  let names = 0, strings = 0;
  const lineText = (() => { const ls = input.src ? input.src.split('\n') : []; return (l: number) => (ls[l - 1] ?? '').trim().slice(0, 140); })();
  const hit = (name: string, h: Omit<BehaviorHit, 'indicator'>) => {
    for (const { id } of byName.get(name) ?? []) {
      const c = cats.get(id)!;
      c.count++;
      if (!c.indicators.includes(name)) c.indicators.push(name);
      if (c.hits.length < maxHits && !c.hits.some(x => x.indicator === name && x.line === h.line && x.where === h.where)) c.hits.push({ indicator: name, ...h });
    }
  };
  const scanString = (s: string, at: { line?: number; where?: string }) => {
    strings++;
    // exact API names used as string constants (obfuscators index by string: game["HttpGet"], or decoded constants)
    const key = s.trim();
    if (key.length <= 40 && byName.has(key)) hit(key, { ...at, text: at.line ? lineText(at.line) : JSON.stringify(s) });
    // dotted paths inside one string: "syn.request"
    for (const part of key.length <= 80 ? key.split(/[.:]/) : []) if (part !== key && byName.has(part) && part.length > 3) hit(part, { ...at, text: JSON.stringify(s.slice(0, 120)) });
    for (const m of s.matchAll(URL_RE)) { const u = m[0].replace(/[),;]+$/, ''); if (!urls.has(u)) urls.set(u, { url: u, kind: urlKind(u), ...at }); }
    for (const m of s.matchAll(ASSET_RE)) if (!urls.has(m[0])) urls.set(m[0], { url: m[0], kind: 'roblox-asset', ...at });
  };
  if (input.src) {
    const { tokens } = lex(input.src);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === T.Name) {
        names++;
        if (byName.has(t.value)) {
          // skip local re-declarations' noise only for very generic names used as plain identifiers (load/request/dump/Kick…)
          const prev = tokens[i - 1], next = tokens[i + 1];
          const generic = /^(load|request|dump|require|Teleport|Kick|crypt|syn|Drawing|Orion|Fluent|hwid|HWID|Clipboard)$/.test(t.value);
          const asApi = (prev && prev.type === T.Punct && (prev.value === '.' || prev.value === ':')) || (next && next.type === T.Punct && (next.value === '(' || next.value === '.' || next.value === ':')) || (next && next.type === T.String);
          if (!generic || asApi) hit(t.value, { line: t.line, text: lineText(t.line) });
        }
      } else if (t.type === T.String && t.cooked !== undefined) scanString(t.cooked, { line: t.line });
    }
  }
  for (const s of input.strings ?? []) scanString(s.value, { where: s.where });
  // require(<asset id>) loads a remote module
  if (input.src) for (const m of input.src.matchAll(/\brequire\s*\(\s*(\d{5,})\s*\)/g)) { const u = 'require(' + m[1] + ')'; if (!urls.has(u)) urls.set(u, { url: u, kind: 'roblox-module', line: input.src.slice(0, m.index).split('\n').length }); }
  const urlList = [...urls.values()];
  // verdict
  const has = (id: string) => (cats.get(id)?.count ?? 0) > 0;
  const kinds = new Set(urlList.map(u => u.kind));
  const verdict: string[] = [];
  if (kinds.has('discord-webhook')) verdict.push('HIGH: posts to a Discord webhook — typical of loggers/stealers (check what data is sent)');
  if (kinds.has('telegram-bot') || kinds.has('webhook')) verdict.push('HIGH: sends data to a webhook / Telegram bot endpoint — exfiltration channel');
  if (kinds.has('ip-logger') || kinds.has('ip-lookup')) verdict.push('HIGH: contacts an IP lookup / IP logger service');
  if (has('identity') && (has('network') || kinds.size)) verdict.push('HIGH: reads identifying data (HWID / client id / account info) and has network access — possible data exfiltration');
  if (has('loader') && (has('network') || kinds.has('code-host'))) verdict.push('loader: downloads code (HttpGet / code host URL) and runs it with loadstring — the real payload is remote');
  if (has('filesystem')) verdict.push('writes / reads files in the executor workspace (config, keys or cached payloads)');
  if (has('hooks')) verdict.push('hooks functions or metatables (__namecall / hookfunction) — remote spy, anti-cheat bypass or tamper protection');
  if (has('clipboard')) verdict.push('touches the clipboard (key systems often copy a link)');
  if (has('remote')) verdict.push('fires game remotes / simulates input (game automation)');
  if (has('anti') && cats.get('anti')!.count >= 3) verdict.push('anti-tamper / anti-debug checks (debug.getinfo / traceback / getfenv)');
  if (!verdict.length) verdict.push(names + strings ? 'no high-risk indicator found in the visible names/strings (decode constants or the VM chunk first — obfuscated scripts hide them)' : 'nothing scanned');
  const order = { high: 0, warn: 1, notice: 2, info: 3 };
  const categories = [...cats.values()].filter(c => c.count).sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  return { categories, urls: urlList.slice(0, 500), verdict, scanned: { names, strings } };
}

export function formatBehavior(r: BehaviorReport, opts: { label?: string } = {}): string {
  const out = [`BEHAVIOUR / IOC REPORT${opts.label ? ' — ' + opts.label : ''}  (static: ${r.scanned.names.toLocaleString('en-US')} identifiers, ${r.scanned.strings.toLocaleString('en-US')} strings scanned)`, '', 'VERDICT', ...r.verdict.map(v => '- ' + v)];
  if (r.urls.length) { out.push('', `URLS / ASSETS (${r.urls.length})`); for (const u of r.urls.slice(0, 80)) out.push(`  [${u.kind}] ${u.url}${u.line ? `  (L${u.line})` : u.where ? `  (${u.where})` : ''}`); }
  for (const c of r.categories) {
    out.push('', `${c.severity.toUpperCase().padEnd(6)} ${c.title} — ${c.count} hit(s): ${c.indicators.join(', ')}`);
    for (const h of c.hits) out.push(`    ${h.line ? ('L' + h.line).padEnd(7) : (h.where ?? '').padEnd(7)} ${h.indicator.padEnd(18)} ${h.text}`);
  }
  return out.join('\n');
}

/** Every string value inside a dumped chunk / JSON document, with its key path (structural keys are skipped). */
export function collectJsonStrings(json: unknown, max = 200000): Array<{ value: string; where: string }> {
  const out: Array<{ value: string; where: string }> = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, path: string) => {
    if (out.length >= max) return;
    const u = unbytes(v) as unknown;
    if (typeof u === 'string') { out.push({ value: u, where: path || '$' }); return; }
    if (!u || typeof u !== 'object' || seen.has(u)) return;
    seen.add(u);
    if (Array.isArray(u)) u.forEach((x, i) => walk(x, path ? `${path}.${i + 1}` : String(i + 1)));
    else for (const [k, x] of Object.entries(u as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(json, '');
  return out;
}
