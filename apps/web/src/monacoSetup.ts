// Self-host a LEAN Monaco (editor API + Lua/Python only) so PRISM loads fast and works offline.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding';
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations';
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

(self as any).MonacoEnvironment = { getWorker() { return new editorWorker(); } };
loader.config({ monaco });

// PRISM disassembly listing language (Luau/Lua 5.1/custom VM)
monaco.languages.register({ id: 'prism-asm' });
monaco.languages.setMonarchTokensProvider('prism-asm', {
  tokenizer: {
    root: [
      [/^\s*;.*$/, 'comment'],
      [/--.*$/, 'comment.lift'],
      [/;.*$/, 'comment'],
      [/^\s*(function|Function)\b.*$/, 'keyword.fn'],
      [/^\s*[0-9a-fA-F]{4,}\b/, 'number.pc'],
      [/\b[A-Z][A-Z0-9_]{1,}\b/, 'keyword.op'],
      [/\b[RKUP]\d+\b/, 'variable.reg'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/[-+]?\b\d+(\.\d+)?([eE][-+]?\d+)?\b/, 'number'],
      [/\[[^\]]*\]/, 'type'],
      [/@\d+/, 'comment'],
    ],
  },
});

monaco.editor.defineTheme('prism', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: 'comment', foreground: '6f6396', fontStyle: 'italic' },
    { token: 'comment.lift', foreground: '8fd8ff', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'ff5ce1', fontStyle: 'bold' },
    { token: 'keyword.op', foreground: 'ff7ce8', fontStyle: 'bold' },
    { token: 'keyword.fn', foreground: 'ffcf5c', fontStyle: 'bold' },
    { token: 'variable.reg', foreground: 'c9a6ff' },
    { token: 'number.pc', foreground: '4a3f73' },
    { token: 'string', foreground: '5dffb0' },
    { token: 'number', foreground: '5ce1ff' },
    { token: 'type', foreground: 'ffcf5c' },
    { token: 'identifier', foreground: 'ece6ff' },
    { token: 'delimiter', foreground: 'a99bd6' },
  ],
  colors: {
    'editor.background': '#0a0618', 'editor.foreground': '#ece6ff',
    'editorLineNumber.foreground': '#4a3f73', 'editorLineNumber.activeForeground': '#b26bff',
    'editor.selectionBackground': '#b26bff44', 'editor.lineHighlightBackground': '#1a1035',
    'editorCursor.foreground': '#ff5ce1', 'editorIndentGuide.background1': '#1e1540',
    'scrollbarSlider.background': '#b26bff33', 'editor.findMatchHighlightBackground': '#ff5ce144',
    'editor.wordHighlightBackground': '#5ce1ff22', 'editorGutter.background': '#0a0618',
    'diffEditor.insertedTextBackground': '#5dffb022', 'diffEditor.removedTextBackground': '#ff5c8a22',
  },
});
