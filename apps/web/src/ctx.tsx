// Global UI context: current script, analysis target, backend link, cross-tab navigation and toasts.
import React, { createContext, useContext } from 'react';
import type { FullReport, CleanResult } from '@prism/core';
import type { Health } from './api.js';

export type Target = 'input' | 'cleaned';
export type TabId = 'actions' | 'anatomy' | 'overview' | 'cleaned' | 'callgraph' | 'strings' | 'tokens' | 'vm' | 'opcodes' | 'disasm' | 'constants' | 'search' | 'python' | 'blob' | 'tools' | 'workspace';

export interface Inbox { kind: 'blob' | 'disasm' | 'vm' | 'search' | 'python' | 'tool'; payload: any; nonce: number; }

export interface PrismCtx {
  src: string;
  name: string;
  clean: CleanResult | null;
  report: FullReport | null;
  target: Target;
  /** text of the current analysis target (input or cleaned) */
  text: string;
  setTarget: (t: Target) => void;
  backend: Health | null;
  refreshBackend: () => void;
  /** workspace script ids (uploaded on demand when the backend is connected) */
  ensureScriptId: (t?: Target) => Promise<string | null>;
  reveal: (line: number, col?: number, t?: Target) => void;
  goTab: (t: TabId) => void;
  send: (kind: Inbox['kind'], payload: any) => void;
  inbox: Inbox | null;
  setInput: (text: string, name?: string) => void;
  toast: (msg: string, kind?: 'ok' | 'bad' | 'info') => void;
}

export const Ctx = createContext<PrismCtx>(null as unknown as PrismCtx);
export const usePrism = () => useContext(Ctx);

/** read an inbox message addressed to `kind` once */
export function useInbox(kind: Inbox['kind'], onMsg: (payload: any) => void) {
  const { inbox } = usePrism();
  const seen = React.useRef(0);
  React.useEffect(() => {
    if (inbox && inbox.kind === kind && inbox.nonce !== seen.current) { seen.current = inbox.nonce; onMsg(inbox.payload); }
  }, [inbox, kind, onMsg]);
}
