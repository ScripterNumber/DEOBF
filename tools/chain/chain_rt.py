# ---------------------------------------------------------------------------
# PRISM chain runtime (universal): continue a VM loader's decoding past its first virtualised stage
# WITHOUT running that stage. The closure-factory hook hands back a stub instead of the first VM closure;
# the loader then calls the stub with every argument it passes to the virtualised program (readers,
# chunk readers, helper tables ...). The stub finds the payload buffer + cursor, classifies the callable
# arguments by differential probing in forked children (scalar readers move the cursor a few bytes and
# return numbers; a chunk reader returns a proto-shaped table), then scans cursor offsets for the next
# chunk (each attempt in a forked child, validated against the shape of the first root proto) and dumps
# the next stage's root proto in the same dump format as the first stage. Nothing virtualised runs.
# ---------------------------------------------------------------------------
import os as _pc_os, json as _pc_json, time as _pc_time, sys as _pc_sys, select as _pc_select, signal as _pc_signal


def _pc_log(*a):
    _pc_sys.stderr.write('[chain] ' + ' '.join(str(x) for x in a) + '\n')
    _pc_sys.stderr.flush()


def _pc_first(v):
    if isinstance(v, tuple):
        return v[0] if v else None
    return v


def _pc_names():
    names = {}
    try:
        for k, v in list(G.h.items()):
            kk = _unkey(k)
            if isinstance(v, LuaTable):
                for k2, v2 in list(v.h.items()):
                    if callable(v2) and not isinstance(v2, LuaTable):
                        names.setdefault(id(v2), str(kk) + '.' + str(_unkey(k2)))
            elif callable(v):
                names.setdefault(id(v), str(kk))
    except Exception:
        pass
    return names


def _pc_converter():
    seen = {}
    names = _pc_names()

    def key(k):
        if k is True: return 'true'
        if k is False: return 'false'
        if isinstance(k, float) and k.is_integer(): return str(int(k))
        if isinstance(k, LuaTable): return '<table>'
        return str(k)

    def conv(x):
        if isinstance(x, LuaTable):
            if id(x) in seen: return {'$ref': seen[id(x)]}
            me = seen[id(x)] = len(seen) + 1
            n = x.length()
            out = {'$id': me}
            if n: out['$arr'] = [conv(x.h.get(i)) for i in range(1, n + 1)]
            rest = {}
            for k, v in list(x.h.items()):
                kk = _unkey(k)
                if isinstance(kk, (int, float)) and not isinstance(kk, bool) and 1 <= kk <= n and float(kk).is_integer(): continue
                rest[key(kk)] = conv(v)
            if rest: out['$map'] = rest
            if x.meta is not None: out['$meta'] = conv(x.meta)
            return out
        if isinstance(x, LuaBuffer): return {'$buffer': bytes(x.b).hex()}
        if isinstance(x, str): return x if all(32 <= ord(c) < 127 for c in x) else {'$bytes': x.encode('latin-1', 'replace').hex()}
        if isinstance(x, float) and (x != x or x in (float('inf'), float('-inf'))): return {'$num': 'nan' if x != x else ('inf' if x > 0 else '-inf')}
        if x is None or isinstance(x, (bool, int, float)): return x
        if callable(x):
            r = {'$fn': names.get(id(x), getattr(x, '__name__', '?'))}
            at = getattr(x, '__lua_at__', None)
            if at is not None: r['$at'] = at
            return r
        return repr(x)
    return conv


def _pc_kind(v):
    if isinstance(v, LuaTable): return 'table'
    if isinstance(v, bool): return 'boolean'
    if isinstance(v, (int, float)): return 'number'
    if isinstance(v, str): return 'string'
    if v is None: return 'nil'
    if callable(v): return 'function'
    return type(v).__name__


def _pc_shape(t):
    if not isinstance(t, LuaTable): return None
    return {str(_unkey(k)): _pc_kind(v) for k, v in list(t.h.items())}


def _pc_sim(a, b):
    if a is None or b is None: return 0.0
    sa, sb = set(a.items()), set(b.items())
    return len(sa & sb) / max(1, len(sa | sb))


def _pc_count_shaped(root, shape, limit=200000):
    # proto-shaped tables reachable from root (nested protos), bounded walk
    seen, stack, n, steps = set(), [root], 0, 0
    while stack and steps < limit:
        t = stack.pop(); steps += 1
        if not isinstance(t, LuaTable) or id(t) in seen: continue
        seen.add(id(t))
        if _pc_sim(_pc_shape(t), shape) >= 0.8: n += 1
        for v in list(t.h.values()):
            if isinstance(v, LuaTable) and id(v) not in seen: stack.append(v)
    return n


class _PcPool:
    """run jobs in forked children (at most `jobs` at once), each with a wall-clock limit"""
    def __init__(self, jobs=2, timeout=4.0):
        self.jobs, self.timeout, self.live = jobs, timeout, {}

    def _spawn(self, tag, fn):
        r, w = _pc_os.pipe()
        pid = _pc_os.fork()
        if pid == 0:
            _pc_os.close(r)
            try:
                res = fn()
            except BaseException as e:
                res = {'err': (type(e).__name__ + ': ' + str(getattr(e, 'value', e)))[:240]}
            try:
                data = _pc_json.dumps(res, default=str).encode()
            except Exception as e:
                data = _pc_json.dumps({'err': 'json: ' + str(e)}).encode()
            try:
                _pc_os.write(w, data[:60000])
            finally:
                _pc_os._exit(0)
        _pc_os.close(w)
        self.live[r] = (pid, tag, _pc_time.time(), [])

    def _reap(self, block):
        done = []
        if not self.live: return done
        rl, _, _ = _pc_select.select(list(self.live), [], [], 0.05 if block else 0)
        for r in rl:
            pid, tag, t0, buf = self.live[r]
            chunk = _pc_os.read(r, 65536)
            if chunk:
                buf.append(chunk); continue
            _pc_os.close(r); del self.live[r]
            try: _pc_os.waitpid(pid, 0)
            except ChildProcessError: pass
            try: res = _pc_json.loads(b''.join(buf).decode() or '{}')
            except Exception: res = {'err': 'bad result'}
            done.append((tag, res))
        now = _pc_time.time()
        for r, (pid, tag, t0, buf) in list(self.live.items()):
            if now - t0 > self.timeout:
                try: _pc_os.kill(pid, _pc_signal.SIGKILL)
                except ProcessLookupError: pass
                try: _pc_os.waitpid(pid, 0)
                except ChildProcessError: pass
                _pc_os.close(r); del self.live[r]
                done.append((tag, {'err': 'timeout'}))
        return done

    def map(self, items, fn, stop=None):
        """items: iterable of tags; fn(tag) runs in the child. stop(results) -> True ends early."""
        it, results, exhausted = iter(items), {}, False
        while True:
            while not exhausted and len(self.live) < self.jobs:
                try: tag = next(it)
                except StopIteration: exhausted = True; break
                self._spawn(tag, (lambda t: (lambda: fn(t)))(tag))
            for tag, res in self._reap(True):
                results[tag] = res
            if stop and stop(results):
                for r, (pid, tag, t0, buf) in list(self.live.items()):
                    try: _pc_os.kill(pid, _pc_signal.SIGKILL)
                    except ProcessLookupError: pass
                    try: _pc_os.waitpid(pid, 0)
                    except ChildProcessError: pass
                    _pc_os.close(r); del self.live[r]
                return results
            if exhausted and not self.live:
                return results


def _prism_chain(args, ctx):
    out = _pc_os.environ.get('PRISM_CHAIN_OUT', 'vm_dump.stage2.json')
    maxscan = int(_pc_os.environ.get('PRISM_CHAIN_MAXSCAN', '0') or 0)
    jobs = int(_pc_os.environ.get('PRISM_CHAIN_JOBS', '2'))
    report = {'stage': 2}
    root1 = ctx['root']
    shape1 = _pc_shape(root1)
    report['root_shape'] = shape1
    tabs = [(n, v) for n, v in list(ctx['tables'].items()) + list(ctx['params'].items()) if isinstance(v, LuaTable)]
    # 1. payload buffer: the biggest buffer (or string) held in a visible table
    best = None
    for name, t in tabs:
        for k, v in list(t.h.items()):
            size = len(v.b) if isinstance(v, LuaBuffer) else (len(v) if isinstance(v, str) and len(v) > 256 else -1)
            if size > 0 and (best is None or size > best[3]):
                best = (name, t, _unkey(k), size)
    if best is None:
        _pc_log('no payload buffer in the visible tables'); _pc_os._exit(4)
    bname, T, bkey, blen = best
    report['buffer'] = {'table': bname, 'slot': bkey, 'size': blen}

    def ints():
        return {_unkey(k): v for k, v in list(T.h.items()) if isinstance(v, (int, float)) and not isinstance(v, bool)}
    cur0 = ints()
    cands = [k for k, v in cur0.items() if float(v).is_integer() and 0 < v <= blen]
    _pc_log('payload buffer', bname + '[' + str(bkey) + ']', blen, 'bytes; cursor candidates', {str(k): cur0[k] for k in cands})

    # 2. classify the callable arguments of the virtualised program (each probe in a forked child)
    callables = [i for i, a in enumerate(args) if callable(a) and not isinstance(a, LuaTable)]

    def probe(i):
        before = ints()
        r = _pc_first(args[i]())
        after = ints()
        d = {str(k): after[k] - before.get(k, 0) for k in after if after[k] != before.get(k)}
        return {'ret': _pc_kind(r), 'deltas': d, 'shape_sim': _pc_sim(_pc_shape(r), shape1) if isinstance(r, LuaTable) else 0}
    pool = _PcPool(jobs=jobs, timeout=float(_pc_os.environ.get('PRISM_CHAIN_PROBE_S', '6')))
    probes = pool.map(callables, probe)
    report['probes'] = {str(i + 1): dict(probes.get(i, {}), lua_at=getattr(args[i], '__lua_at__', None)) for i in callables}
    for i in callables:
        _pc_log('arg', i + 1, getattr(args[i], '__lua_at__', None), probes.get(i))
    # cursor: the candidate slot moved by the scalar readers
    votes = {}
    for i, p in probes.items():
        if p.get('ret') in ('number', 'string', 'boolean'):
            for k, dv in (p.get('deltas') or {}).items():
                if 0 < dv <= 16: votes[k] = votes.get(k, 0) + 1
    cursor = None
    for k in sorted(votes, key=lambda k: -votes[k]):
        if any(str(c) == k for c in cands):
            cursor = next(c for c in cands if str(c) == k); break
    if cursor is None and len(cands) == 1: cursor = cands[0]
    if cursor is None:
        _pc_log('cursor slot not identified', votes); _pc_os._exit(5)
    p0 = int(T[cursor])
    report['cursor'] = {'slot': cursor, 'at_stage1_end': p0, 'remaining': blen - p0, 'votes': votes}
    _pc_log('cursor slot', cursor, '=', p0, '(remaining', blen - p0, 'bytes)')
    readers = [i for i in callables if probes.get(i, {}).get('ret') in ('number', 'string', 'boolean')]
    report['scalar_readers'] = {str(i + 1): (probes[i].get('deltas') or {}).get(str(cursor)) for i in readers}
    chunk = [i for i in callables if i not in readers]
    chunk.sort(key=lambda i: (0 if probes.get(i, {}).get('ret') == 'table' else 1, 0 if getattr(args[i], '__lua_at__', None) is not None else 1))
    _pc_log('chunk-reader candidates (arg #):', [i + 1 for i in chunk])

    # 3. scan cursor offsets for the next chunk with each candidate
    limit = blen - p0 if not maxscan else min(maxscan, blen - p0)
    found = None
    for ci in chunk:
        fn = args[ci]
        t0 = _pc_time.time()

        def attempt(d, fn=fn):
            T[cursor] = p0 + d
            r = _pc_first(fn())
            sim = _pc_sim(_pc_shape(r), shape1) if isinstance(r, LuaTable) else 0
            res = {'kind': _pc_kind(r), 'sim': sim, 'end': T[cursor]}
            if sim >= 0.8:
                res['protos'] = _pc_count_shaped(r, shape1)
            return res
        okd = []

        def stop(results):
            # stop when the smallest valid offset is known (all smaller offsets finished)
            valid = sorted(d for d, r in results.items() if r.get('sim', 0) >= 0.8 and r.get('protos', 0) >= 1)
            if not valid: return False
            return all(d in results for d in range(valid[0]))
        pool = _PcPool(jobs=jobs, timeout=float(_pc_os.environ.get('PRISM_CHAIN_TRY_S', '8')))
        res = pool.map(range(limit), attempt, stop)
        valid = sorted(d for d, r in res.items() if r.get('sim', 0) >= 0.8 and r.get('protos', 0) >= 1)
        errs = {}
        for d, r in res.items():
            e = r.get('err')
            if e: errs[e.split(':')[0]] = errs.get(e.split(':')[0], 0) + 1
        _pc_log('arg', ci + 1, 'scanned', len(res), 'offsets in', round(_pc_time.time() - t0, 1), 's; valid', valid[:5], '; failures', errs)
        report.setdefault('scans', []).append({'arg': ci + 1, 'scanned': len(res), 'valid': valid[:20], 'errors': errs})
        if valid:
            found = (ci, valid[0], res[valid[0]]); break
    if not found:
        _pc_log('no next chunk found'); report['found'] = None
        with open(out + '.report.json', 'w') as f: f.write(_pc_json.dumps(report, indent=1, default=str))
        _pc_os._exit(6)
    ci, d, r = found
    report['found'] = {'arg': ci + 1, 'offset': d, 'start': p0 + d, 'end': r.get('end'), 'protos': r.get('protos')}
    _pc_log('next chunk: arg', ci + 1, 'at cursor', p0 + d, '(stage-1 end +', d, ') ->', r)
    # 4. read it for real (in this process) and dump it in the first stage's dump format
    T[cursor] = p0 + d
    root2 = _pc_first(args[ci]())
    report['end_cursor'] = T[cursor]
    post = ctx.get('post')
    if post:
        try:
            report['post'] = post(root2, ctx)
        except BaseException as e:
            report['post_error'] = repr(e)
    conv = _pc_converter()
    dump = {}
    for name, v in ctx['params'].items():
        dump[name] = conv(root2 if v is root1 else v)
    for name, v in ctx['tables'].items():
        if name not in dump: dump[name] = conv(v)
    dump['$chain'] = {'stage': 2, 'args': [conv(a) for a in args]}
    with open(out, 'w') as f: f.write(_pc_json.dumps(dump))
    with open(out + '.report.json', 'w') as f: f.write(_pc_json.dumps(report, indent=1, default=str))
    _pc_log('stage-2 dump written to', out)
    _pc_os._exit(0)
