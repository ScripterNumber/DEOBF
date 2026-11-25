import React, { useState, useCallback } from 'react';

/** Copy-everything primitive. Wrap any value to get a one-click copy button. */
export function Copy({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const onClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  }, [text]);
  return (
    <span className={`copy-btn ${done ? 'copied' : ''} ${className}`} onClick={onClick} title="Copy to clipboard">
      {done ? '✓ Copied' : label}
    </span>
  );
}

/** A block of text with a copy button in the corner. */
export function CopyBlock({ text, max }: { text: string; max?: number }) {
  const shown = max && text.length > max ? text.slice(0, max) + `\n… (+${text.length - max} more chars, copy for full)` : text;
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}><Copy text={text} /></div>
      <pre className="block">{shown}</pre>
    </div>
  );
}

export function Card({ title, right, children, dot = true }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; dot?: boolean }) {
  return (
    <div className="card fade">
      <div className="card-h">
        {dot && <span className="dot" />}
        <span>{title}</span>
        <span className="spacer" />
        {right}
      </div>
      <div className="card-b">{children}</div>
    </div>
  );
}

export function Stat({ k, v, hi }: { k: string; v: React.ReactNode; hi?: boolean }) {
  return <span className={`chip ${hi ? 'hi' : ''}`}>{k} <b>{v}</b></span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
/** Save any text/bytes as a file (works offline). */
export function download(name: string, content: string | Uint8Array, mime = 'text/plain') {
  const blob = new Blob([content as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function Download({ name, content, label = 'Download', mime }: { name: string; content: string | Uint8Array | (() => string | Uint8Array); label?: string; mime?: string }) {
  return <span className="copy-btn" title={`Save as ${name}`} onClick={e => { e.stopPropagation(); download(name, typeof content === 'function' ? content() : content, mime); }}>{label}</span>;
}

/** Segmented control (radio group) */
export function Seg<T extends string>({ value, options, onChange, title }: { value: T; options: Array<T | { v: T; label: React.ReactNode; title?: string }>; onChange: (v: T) => void; title?: string }) {
  return (
    <div className="seg" title={title}>
      {options.map(o => {
        const v = typeof o === 'string' ? o : o.v;
        const label = typeof o === 'string' ? o : o.label;
        return <label key={v} title={typeof o === 'string' ? undefined : o.title}><input type="radio" checked={value === v} onChange={() => onChange(v)} style={{ display: 'none' }} />{label}</label>;
      })}
    </div>
  );
}

export function Toggle({ on, onChange, children, title }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode; title?: string }) {
  return <label className={'toggle ' + (on ? 'on' : '')} title={title}><input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} />{children}</label>;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="field" title={hint}><span>{label}</span>{children}</label>;
}

export function Busy({ on, label = 'Working' }: { on: boolean; label?: string }) {
  if (!on) return null;
  return <div className="busy"><span className="spin-loader" />{label}…</div>;
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="errbox"><b>Error</b> {error}<Copy text={error} /></div>;
}

/** clickable line reference */
export function LineLink({ line, onClick, prefix = 'L' }: { line: number; onClick: (line: number) => void; prefix?: string }) {
  return <span className="line-link" onClick={e => { e.stopPropagation(); onClick(line); }} title="Show in editor">{prefix}{line}</span>;
}

/** collapsible JSON viewer with copy */
export function JsonView({ value, label = 'JSON', open = false, max = 200000 }: { value: unknown; label?: string; open?: boolean; max?: number }) {
  const [o, setO] = useState(open);
  const text = React.useMemo(() => { try { return JSON.stringify(value, null, 2) ?? 'undefined'; } catch (e) { return String(e); } }, [value]);
  return (
    <div className="jsonview">
      <div className="jsonview-h" onClick={() => setO(!o)}><span>{o ? '▾' : '▸'} {label}</span><span className="muted small">{text.length.toLocaleString()} chars</span><span className="spacer" /><Copy text={text} label="Copy JSON" /></div>
      {o && <pre className="block">{text.length > max ? text.slice(0, max) + '\n… (copy for full)' : text}</pre>}
    </div>
  );
}

export function useLocal<T>(key: string, init: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem('prism:' + key); return s ? JSON.parse(s) as T : init; } catch { return init; } });
  const set = useCallback((x: T | ((p: T) => T)) => setV(p => { const n = typeof x === 'function' ? (x as (p: T) => T)(p) : x; try { localStorage.setItem('prism:' + key, JSON.stringify(n)); } catch { /* quota */ } return n; }), [key]);
  return [v, set];
}

export const latin1Bytes = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
export const bytesLatin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
