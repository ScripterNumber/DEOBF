export type GNode = { id: string; name: string; x: number; y: number; vx: number; vy: number; deg: number };

export function forceLayout(nodes: GNode[], edges: { from: string; to: string }[], w: number, h: number) {
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  for (let it = 0; it < 240; it++) {
    const t = 1 - it / 240;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y; const d2 = dx * dx + dy * dy + 0.01;
      const f = 2600 / d2; const d = Math.sqrt(d2);
      dx /= d; dy /= d; a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const e of edges) {
      const a = nodes[idx.get(e.from)!], b = nodes[idx.get(e.to)!]; if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - 90) * 0.02; a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
    }
    for (const n of nodes) {
      n.vx += (w / 2 - n.x) * 0.004; n.vy += (h / 2 - n.y) * 0.004;
      n.x += Math.max(-20, Math.min(20, n.vx)) * t; n.y += Math.max(-20, Math.min(20, n.vy)) * t;
      n.vx *= 0.5; n.vy *= 0.5;
      n.x = Math.max(20, Math.min(w - 20, n.x)); n.y = Math.max(20, Math.min(h - 20, n.y));
    }
  }
}