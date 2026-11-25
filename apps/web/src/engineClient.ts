// Typed promise bridge to the engine worker. A crashed/hung worker is replaced transparently.
import type { FullReport, CleanResult } from '@prism/core';

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const { id, ok, result, error, ms } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve({ result, ms }); else p.reject(new Error(error));
    };
    worker.onerror = (e) => { for (const [, p] of pending) p.reject(new Error(e.message || 'engine worker crashed')); pending.clear(); worker?.terminate(); worker = null; };
  }
  return worker;
}

export function call<T = any>(op: string, src: string, opts?: any): Promise<{ result: T; ms: number }> {
  const id = seq++;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, op, src, opts });
  });
}

/** abort everything in flight (e.g. a runaway analysis) by recycling the worker */
export function resetEngine() {
  worker?.terminate(); worker = null;
  for (const [, p] of pending) p.reject(new Error('cancelled')); pending.clear();
}
export const busyCount = () => pending.size;

export interface FullResult { report: FullReport; clean: CleanResult; }

export const engine = {
  full: (src: string, opts?: any) => call<FullResult>('full', src, opts),
  analyze: (src: string) => call<FullReport>('analyze', src),
  clean: (src: string, opts?: any) => call<CleanResult>('clean', src, opts),
  tokenize: (src: string) => call<any>('tokenize', src),
  op: call,
};
