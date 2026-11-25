// PRISM lift scorecard — universal structural quality metrics for ANY Lua program
// (lifted VM output or ordinary source). Nothing obfuscator- or sample-specific:
// everything is derived from protoInventory (which itself works on any script) plus
// a generic AST walk. Used by the lift_report tool and the auto_lift pipeline so the
// quality of a devirtualisation can be judged in one number instead of by eye.
import type * as A from '../ast.js';
import { protoInventory } from './inventory.js';
import type { Inventory } from './inventory.js';

export interface LiftReport {
	lines: number;
	chars: number;
	functions: number;
	/** deepest closure-creation chain (proto A creates B creates C …) */
	maxDepth: number;
	mode: 'protos' | 'functions';
	/** proto / function count excluding the main chunk */
	units: number;
	/** total closure creation sites across all units */
	closures: number;
	captures: { total: number; box: number; value: number; upvalue: number; expr: number };
	/** percentage of captures whose origin is known (box + value + upvalue) */
	resolvedPct: number;
	/** creation sites whose captured value could not be traced to a register / upvalue */
	unresolved: Array<{ unit: string; line: number; slot: string; text: string }>;
	/** locals every unit shares — the VM's own scaffolding, not real data */
	scaffoldLocals: string[];
	scaffoldGlobals: string[];
	/** 0..100 heuristic: how close the program is to readable, de-virtualised code */
	score: number;
	scoreParts: string[];
	notes: string[];
}

function countFunctions(node: unknown): number {
	let n = 0;
	const seen = new Set<unknown>();
	const visit = (x: unknown): void => {
		if (!x || typeof x !== 'object') return;
		if (seen.has(x)) return;
		seen.add(x);
		if (Array.isArray(x)) { for (const y of x) visit(y); return; }
		const o = x as Record<string, unknown>;
		if (o.type === 'FunctionExpr') n++;
		for (const k in o) if (k !== 'type') visit(o[k]);
	};
	visit(node);
	return n;
}

function deepestChain(inv: Inventory): number {
	const kids = new Map<string, string[]>();
	for (const u of inv.units) kids.set(u.id, u.children.map(c => c.id));
	const memo = new Map<string, number>();
	const stack = new Set<string>();
	const go = (id: string): number => {
		const m = memo.get(id);
		if (m !== undefined) return m;
		if (stack.has(id)) return 0; // cycle guard
		stack.add(id);
		let best = 0;
		for (const c of kids.get(id) ?? []) best = Math.max(best, 1 + go(c));
		stack.delete(id);
		memo.set(id, best);
		return best;
	};
	let max = 0;
	for (const u of inv.units) max = Math.max(max, go(u.id));
	return max;
}

export function liftReport(chunk: A.Chunk, src: string): LiftReport {
	const inv = protoInventory(chunk, src);
	const captures = { total: 0, box: 0, value: 0, upvalue: 0, expr: 0 };
	const unresolved: LiftReport['unresolved'] = [];
	let closures = 0;
	for (const u of inv.units) for (const c of u.children) {
		closures++;
		for (const cap of c.captures) {
			captures.total++;
			captures[cap.kind]++;
			if (cap.kind === 'expr') unresolved.push({ unit: u.id, line: c.line, slot: cap.slot, text: cap.text });
		}
	}
	const resolved = captures.box + captures.value + captures.upvalue;
	const resolvedPct = captures.total ? Math.round((100 * resolved) / captures.total) : 100;
	const scaffoldLocals = inv.common.upvalues.slice();
	const scaffoldGlobals = inv.common.globals.slice();
	const units = inv.units.filter(u => u.id !== 'main').length;

	let score = 100;
	const scoreParts: string[] = [];
	if (captures.total) {
		const pen = Math.round((45 * captures.expr) / captures.total);
		if (pen) { score -= pen; scoreParts.push(`-${pen} unresolved captures (${captures.expr}/${captures.total})`); }
	}
	if (scaffoldLocals.length > 6) { score -= 10; scoreParts.push(`-10 VM scaffolding locals (${scaffoldLocals.length})`); }
	if (score < 0) score = 0;

	const notes: string[] = [];
	if (inv.mode === 'protos') notes.push(`residual VM program: ${inv.protoTable}[n] makers, closures built by ${inv.protoTable}[m](upvalues)`);
	if (captures.expr) notes.push(`${captures.expr} capture(s) still read at run time / untraced — these are the slots to resolve next`);
	if (!closures && inv.mode === 'functions') notes.push('no nested closures — already flat source');
	for (const n of inv.notes) notes.push(n);

	return {
		lines: src.split('\n').length,
		chars: src.length,
		functions: countFunctions(chunk),
		maxDepth: deepestChain(inv),
		mode: inv.mode,
		units,
		closures,
		captures,
		resolvedPct,
		unresolved,
		scaffoldLocals,
		scaffoldGlobals,
		score,
		scoreParts,
		notes,
	};
}

export function formatLiftReport(r: LiftReport, o: { max?: number } = {}): string {
	const max = o.max ?? 40;
	const out: string[] = [];
	out.push(`# lift scorecard — ${r.mode} mode`);
	out.push(`score: ${r.score}/100${r.scoreParts.length ? '  (' + r.scoreParts.join('; ') + ')' : ''}`);
	out.push(`size: ${r.lines} lines, ${r.chars} chars, ${r.functions} function literal(s)`);
	out.push(`structure: ${r.units} ${r.mode === 'protos' ? 'proto' : 'function'}(s), ${r.closures} creation site(s), deepest chain ${r.maxDepth}`);
	out.push(`captures: ${r.captures.total} total — ${r.captures.box} box, ${r.captures.value} by-value, ${r.captures.upvalue} pass-through, ${r.captures.expr} untraced → ${r.resolvedPct}% resolved`);
	if (r.scaffoldLocals.length) out.push(`scaffolding locals (not real data): ${r.scaffoldLocals.slice(0, max).join(', ')}${r.scaffoldLocals.length > max ? ', …' : ''}`);
	if (r.scaffoldGlobals.length) out.push(`scaffolding globals: ${r.scaffoldGlobals.slice(0, max).join(', ')}${r.scaffoldGlobals.length > max ? ', …' : ''}`);
	if (r.unresolved.length) {
		out.push(`untraced captures (${r.unresolved.length}):`);
		for (const u of r.unresolved.slice(0, max)) out.push(`  ${r.mode === 'protos' ? 'proto ' : ''}${u.unit} @${u.line} slot ${u.slot}: ${u.text.length > 50 ? u.text.slice(0, 49) + '…' : u.text}`);
		if (r.unresolved.length > max) out.push(`  … +${r.unresolved.length - max} more`);
	}
	for (const n of r.notes) out.push('note: ' + n);
	return out.join('\n');
}
