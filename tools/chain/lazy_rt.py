# ---------------------------------------------------------------------------
# PRISM lazy-constant resolver (runs on live tables right after the next chunk was read).
# Some VM loaders keep constants out of the operand arrays and resolve them on first access through an
# __index metamethod: a 'pending' table maps a handle (stored in a paired operand array) to a record
#   { value, type, proto1, pc1, field1, proto2, pc2, field2, ... }
# and the resolver decodes the value once and writes it to proto[field][pc] (clearing proto[pair[field]][pc]).
# Parameters (pending-table path, LCG multiplier / increment, table xor, field pairing) come from the
# analysis of the first stage (PRISM_LAZY json); nothing here is sample-specific.
# ---------------------------------------------------------------------------


def _pl_get(t, path):
    for p in [x for x in str(path).replace('/', '.').split('.') if x != '']:
        if not isinstance(t, LuaTable): return None
        t = t[int(p) if p.lstrip('-').isdigit() else p]
    return t


def _pl_decode_string(s, a, c, xk):
    if not s: return s
    b1 = ord(s[0])
    if b1 == 0:
        return s[1:]
    key = (a * ord(s[1]) + c) % 256
    out = []
    for ch in s[2:]:
        out.append(chr((ord(ch) ^ key) ^ xk))
        key = (a * key + c) % 256
    return ''.join(out)


def _pl_is_rec(r):
    try:
        return isinstance(r, LuaTable) and r[2] in ('string', 'number', 'boolean') and isinstance(r[3], LuaTable)
    except Exception:
        return False


def _pl_autodetect(ctx):
    # universal: BFS over live tables for a map whose values look like lazy-constant records,
    # then recover the string cipher (affine LCG key stream over bytes) by maximising printable output
    seen, q, found = set(), [], None
    for name, t in list(ctx['tables'].items()) + list(ctx['params'].items()):
        if isinstance(t, LuaTable): q.append((t, str(name), 0))
    while q and found is None:
        t, path, d = q.pop(0)
        if id(t) in seen or d > 4: continue
        seen.add(id(t))
        items = list(getattr(t, 'h', {}).items())
        try:
            arr = [(i, t[i]) for i in range(1, min(t.length(), 400) + 1)]
        except Exception:
            arr = []
        vals = [v for _, v in items[:200]]
        if len(vals) >= 3 and sum(1 for v in vals if _pl_is_rec(v)) >= 0.8 * len(vals):
            found = (t, path); break
        for k, v in items[:2000] + arr:
            if isinstance(v, LuaTable): q.append((v, path + '.' + str(k), d + 1))
    if found is None:
        return {'why': 'no pending-record map reachable'}
    t, path = found
    strs = [r[1] for r in t.h.values() if _pl_is_rec(r) and r[2] == 'string' and isinstance(r[1], str) and len(r[1]) > 3 and ord(r[1][0]) != 0][:40]
    # stage 1: key stream (a, c) — a constant output xor keeps the text consistent, so score printable bytes
    cands = []
    for a in range(256):
        for c in range(256):
            sc = 0
            for s in strs[:12]:
                o = _pl_decode_string(s, a, c, 0)
                sc += sum(1 for ch in o if 32 <= ord(ch) < 127)
            cands.append((sc, a, c))
    cands.sort(reverse=True)
    # stage 2: constant xor of the output — score letters / digits / space / common punctuation
    good = set(map(ord, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _.,:;!?()[]-/'))
    best = (-1, 0, 0, 0)
    for _, a, c in cands[:5]:
        dec = [_pl_decode_string(s, a, c, 0) for s in strs]
        for xk in range(256):
            sc = sum(1 for o in dec for ch in o if (ord(ch) ^ xk) in good)
            if sc > best[0]: best = (sc, a, c, xk)
    total = sum(max(0, len(s) - 2) for s in strs) or 1
    root = path.split('.')[0]
    return {'table': root, 'pending': '.'.join(path.split('.')[1:]), 'a': best[1], 'c': best[2], 'x': best[3],
            '_obj': t, 'why': 'auto', 'confidence': round(best[0] / total, 3)}


def _prism_post(root2, ctx):
    import json as _j, os as _o
    cfg = _j.loads(_o.environ.get('PRISM_LAZY', 'null') or 'null')
    if not cfg:
        cfg = _pl_autodetect(ctx)
        if not cfg.get('pending'):
            return {'lazy': 'not configured; autodetect: ' + str(cfg.get('why'))}
    # the table holding the pending map: the configured one, else the first live table / param where the path exists
    cands = []
    if cfg.get('table'):
        cands.append(ctx['tables'].get(cfg['table'], ctx['params'].get(cfg['table'])))
    cands += list(ctx['tables'].values()) + list(ctx['params'].values())
    E = None
    for c in cands:
        if c is None:
            continue
        try:
            cur = c
            for p in str(cfg['pending']).split('.'):
                cur = cur[int(p)]
            if cur is not None:
                E = c
                break
        except Exception:
            continue
    if E is None:
        E = next((c for c in cands if c is not None), None)
    pend = cfg['_obj'] if cfg.get('_obj') is not None else _pl_get(E, cfg['pending'])
    if not isinstance(pend, LuaTable):
        return {'lazy': 'pending table not found at ' + str(cfg['pending'])}
    a, c, xk = int(cfg['a']), int(cfg['c']), int(cfg.get('x', 0))
    pair = {int(k): int(v) for k, v in cfg.get('pair', {}).items()}
    if not pair:
        # the handle lives in a paired operand array of the same proto at the same pc: vote field -> paired field
        votes = {}
        for hk, rec in list(pend.h.items())[:400]:
            if not isinstance(rec, LuaTable): continue
            n, i = rec.length(), 3
            while i <= n:
                t, pc, f = rec[i], rec[i + 1], rec[i + 2]
                if isinstance(t, LuaTable) and isinstance(f, (int, float)):
                    for f2 in range(1, 33):
                        if f2 == f: continue
                        col = t[f2]
                        if isinstance(col, LuaTable):
                            hv = col[pc]
                            if isinstance(hv, (int, float)) and isinstance(hk, (int, float)) and hv == hk:
                                votes[(int(f), f2)] = votes.get((int(f), f2), 0) + 1
                i += 3
        for (f, f2), nv in sorted(votes.items(), key=lambda kv: -kv[1]):
            if f not in pair and nv >= 3: pair[f] = f2
    cfg_report = {k: v for k, v in cfg.items() if not k.startswith('_')}
    cfg_report['pair'] = pair
    stats = {'records': 0, 'writes': 0, 'string': 0, 'number': 0, 'boolean': 0, 'other': 0, 'config': cfg_report, 'samples': []}
    for hk, rec in list(pend.h.items()):
        if not isinstance(rec, LuaTable):
            continue
        v, ty = rec[1], rec[2]
        if ty == 'boolean':
            v = not truthy(v); stats['boolean'] += 1
        elif ty == 'string':
            v = _pl_decode_string(v, a, c, xk); stats['string'] += 1
            if len(stats['samples']) < 40: stats['samples'].append(v[:60])
        elif ty == 'number':
            if v != 0: v = -v
            stats['number'] += 1
        else:
            stats['other'] += 1
        n = rec.length()
        i = 3
        while i <= n:
            t, pc, f = rec[i], rec[i + 1], rec[i + 2]
            if isinstance(t, LuaTable) and isinstance(t[f], LuaTable):
                t[f][pc] = v
                pf = pair.get(int(f)) if isinstance(f, (int, float)) else None
                if pf is not None and isinstance(t[pf], LuaTable):
                    t[pf][pc] = None
                stats['writes'] += 1
            i += 3
        stats['records'] += 1
    return stats
