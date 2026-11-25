import React from 'react';
import { GUIDE } from '../../../../packages/tools/src/guide.js';
import { usePrism } from '../ctx.js';
import { Copy } from './ui.js';

export function Help({ onClose }: { onClose: () => void }) {
  const { backend } = usePrism();
  const mcpUrl = backend?.mcp ?? `${location.origin}/mcp`;
  const repo = '/path/to/prism';
  const desktop = JSON.stringify({ mcpServers: { prism: { command: 'npx', args: ['tsx', `${repo}/apps/mcp/src/server.ts`, '--workspace', `${repo}/workspace`] } } }, null, 2);
  const httpCfg = JSON.stringify({ mcpServers: { prism: { type: 'http', url: mcpUrl } } }, null, 2);
  const claudeCode = `claude mcp add --transport http prism ${mcpUrl}\n# or stdio:\nclaude mcp add prism -- npx tsx ${repo}/apps/mcp/src/server.ts`;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-h"><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--neon)', boxShadow: '0 0 8px var(--neon)' }} />PRISM — help, workflow & MCP<span className="spacer" /><span className="x-btn" onClick={onClose}>×</span></div>
        <div className="modal-b">
          <div className="cards" style={{ padding: 0 }}>
            <div className="card"><div className="card-h"><span className="dot" />Shortcuts</div><div className="card-b">
              <div className="row"><span className="kbd">Ctrl+Enter</span> analyze <span className="kbd">Ctrl+Shift+F</span> search tab <span className="kbd">F1</span> help <span className="kbd">Ctrl+F</span> find in editor <span className="kbd">Ctrl+G</span> go to line <span className="kbd">Esc</span> close</div>
              <div className="small" style={{ marginTop: 8 }}>Every line number (<span className="line-link">L123</span>) jumps to the code in the left editor. The <b>on input | cleaned</b> switch picks which code the analysis tabs work on. Every output has a Copy button; tables copy as TSV/JSON.</div>
            </div></div>
            <div className="card"><div className="card-h"><span className="dot" />Connect an AI (MCP)<span className="spacer" /><span className={'pill ' + (backend ? 'ok' : '')}>{backend ? 'server online' : 'server offline'}</span></div><div className="card-b">
              <div className="small">Streamable HTTP endpoint (same server as this UI): <span className="mono" style={{ color: 'var(--neon3)' }}>{mcpUrl}</span> <Copy text={mcpUrl} /></div>
              <div className="sec-title" style={{ marginTop: 10 }}>Claude Code</div>
              <div style={{ position: 'relative' }}><div style={{ position: 'absolute', right: 8, top: 8 }}><Copy text={claudeCode} /></div><pre className="block">{claudeCode}</pre></div>
              <div className="sec-title" style={{ marginTop: 10 }}>Claude Desktop / Cursor (stdio) — replace {repo}</div>
              <div style={{ position: 'relative' }}><div style={{ position: 'absolute', right: 8, top: 8 }}><Copy text={desktop} /></div><pre className="block">{desktop}</pre></div>
              <div className="sec-title" style={{ marginTop: 10 }}>HTTP clients</div>
              <div style={{ position: 'relative' }}><div style={{ position: 'absolute', right: 8, top: 8 }}><Copy text={httpCfg} /></div><pre className="block">{httpCfg}</pre></div>
            </div></div>
            <div className="card"><div className="card-h"><span className="dot" />Workflow guide (also served to AI agents)<span className="spacer" /><Copy text={GUIDE} /></div><div className="card-b"><pre className="block" style={{ maxHeight: 'none' }}>{GUIDE}</pre></div></div>
          </div>
        </div>
      </div>
    </div>
  );
}
