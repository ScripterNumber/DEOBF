// Read Lua syntax and literal data only; this program never evaluates the input.
// Usage: npx tsx scratch/dv/inspect.ts <wrapper.lua> <chunk-local> <hex-local> <dispatcher> [slot] [buffer-output]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from '../../packages/core/src/parser.js';
import { walk } from '../../packages/core/src/ast.js';
import { print } from '../../packages/core/src/printer.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function literalLocals(source: string, names: string[]): Map<string, string> {
  const parsed = parse(source);
  if (parsed.errors.length) throw new Error(`wrapper parse errors: ${parsed.errors.length}`);
  const result = new Map<string, string>();
  for (const statement of parsed.chunk.body) {
    if (statement.type !== 'LocalStat') continue;
    statement.names.forEach((name, i) => {
      if (!names.includes(name)) return;
      const value = statement.init[i];
      if (!value || value.type !== 'StringLit' || !value.long || result.has(name)) {
        throw new Error(`expected one long string initializer for ${name}`);
      }
      result.set(name, value.value);
    });
  }
  for (const name of names) if (!result.has(name)) throw new Error(`missing ${name}`);
  return result;
}

function keyOf(field: any): string | null {
  if (field.kind === 'named') return field.name;
  if (field.key?.type === 'NumberLit') return String(field.key.value);
  return null;
}

function inspect(source: string, dispatcher: string, slot?: string) {
  const { chunk, errors } = parse(source);
  if (errors.length) throw new Error(`chunk parse errors: ${errors.length}`);
  const tables: any[] = [];
  walk(chunk, (node: any) => {
    if (node.type === 'TableExpr' && node.fields.some((field: any) => keyOf(field) === dispatcher && field.value.type === 'FunctionExpr')) tables.push(node);
  });
  if (tables.length !== 1) throw new Error(`expected one table defining ${dispatcher}, found ${tables.length}`);
  const table = tables[0];
  const fields = new Map<string, any>();
  for (const field of table.fields) {
    const key = keyOf(field);
    if (key !== null && field.value.type === 'FunctionExpr') {
      if (fields.has(key)) throw new Error(`duplicate function key ${key}`);
      fields.set(key, field.value);
    }
  }
  const fn = fields.get(dispatcher);
  const receiver = fn.params[0];
  if (!receiver) throw new Error('dispatcher has no receiver parameter');
  const calls: any[] = [];
  walk(fn, (node: any) => {
    if (node.type === 'MethodCallExpr' && node.obj?.type === 'NameExpr' && node.obj.name === receiver) {
      calls.push({ method: node.method, arguments: node.args.map((arg: any) => print(arg)), offset: node.loc?.start });
    }
  });
  const computed: any[] = [];
  for (const name of new Set(calls.map(call => call.method))) {
    const method = fields.get(name);
    if (!method || !method.params[0]) continue;
    walk(method, (node: any) => {
      if (node.type === 'IndexExpr' && node.obj?.type === 'NameExpr' && node.obj.name === method.params[0]
          && node.index.type !== 'NumberLit' && node.index.type !== 'StringLit') {
        const argumentIndex = node.index.type === 'NameExpr' && method.params.filter((p: string) => p === node.index.name).length === 1
          ? method.params.indexOf(node.index.name) - 1 : -1;
        const sites = calls.filter(call => call.method === name);
        const bindings = argumentIndex < 0 ? [] : sites.map(call => call.arguments[argumentIndex]).filter((arg: string | undefined) => arg !== undefined);
        const writes: string[] = [];
        for (const binding of new Set(bindings)) {
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(binding)) continue;
          walk(fn, (entry: any) => {
            if ((entry.type === 'LocalStat' && entry.names.includes(binding)) ||
                (entry.type === 'AssignStat' && entry.targets.some((target: any) => target.type === 'NameExpr' && target.name === binding))) {
              writes.push(print(entry));
            }
          });
        }
        computed.push({ method: name, expression: print(node), offset: node.loc?.start,
          parameters: method.params, dispatcherCalls: sites, selectorBindings: bindings, selectorWrites: writes });
      }
    });
  }
  const callers: any[] = [];
  for (const [key, method] of fields) {
    walk(method, (node: any) => {
      if (node.type === 'MethodCallExpr' && node.method === dispatcher && node.obj?.type === 'NameExpr') {
        callers.push({ field: key, receiver: node.obj.name, arguments: node.args.map((arg: any) => print(arg)), offset: node.loc?.start });
      }
    });
  }
  return { parseErrors: 0, tableFields: table.fields.length, dispatcher,
    dispatcherParameters: fn.params, dispatcherCalls: calls, computedIndexes: computed, callers,
    selectedSlot: slot && fields.has(slot) ? { key: slot, parameters: fields.get(slot).params, source: print(fields.get(slot)) } : null,
    limitations: 'Syntactic candidates only: names can be shadowed and call reachability is not established. Offsets are UTF-16 code units in extracted Lua.' };
}

const [path, chunkName, hexName, dispatcher, slot, bufferOutput] = process.argv.slice(2);
if (!path || !chunkName || !hexName || !dispatcher) throw new Error('usage: inspect.ts <wrapper.lua> <chunk-local> <hex-local> <dispatcher> [slot]');
const input = readFileSync(path);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const literals = literalLocals(utf8.decode(input), [chunkName, hexName]);
const chunk = literals.get(chunkName)!;
const hex = literals.get(hexName)!;
if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error(`${hexName} is not whole-byte hexadecimal`);
const payload = Buffer.from(hex, 'hex');
const chunkBytes = Buffer.from(chunk, 'latin1');
const chunkSource = utf8.decode(chunkBytes);
const analysis = inspect(chunkSource, dispatcher, slot);
if (bufferOutput) writeFileSync(bufferOutput, payload);
console.log(JSON.stringify({ _provenance: { generator: 'CodeRabbit', version: 1 }, source: { path, sha256: sha256(input) },
  chunk: { local: chunkName, bytes: chunkBytes.length, sha256: sha256(chunkBytes) },
  payload: { local: hexName, bytes: payload.length, sha256: sha256(payload), first16Hex: payload.subarray(0, 16).toString('hex') },
  analysis }, null, 2));
