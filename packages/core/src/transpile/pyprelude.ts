// Python runtime shim emitted in front of transpiled Lua code.
// Strings are modelled as Python `str` whose characters are bytes (U+0000..U+00FF),
// exactly like Lua byte strings. Tables are LuaTable (1-based, nil-deleting, metatables).
export const PY_PRELUDE = String.raw`# ---------------------------------------------------------------------------
# PRISM Lua -> Python runtime shim. Strings are byte strings (chars U+0000..U+00FF).
# Generated statically; nothing from the original script was executed.
# ---------------------------------------------------------------------------
import math as _m, sys as _sys, re as _re, random as _rnd, time as _time
from functools import cmp_to_key as _cmp_to_key


class LuaError(Exception):
    def __init__(self, value=None):
        super().__init__(value)
        self.value = value


class Multi(tuple):
    """several Lua return values"""
    __slots__ = ()


def first(v):
    if isinstance(v, Multi):
        return v[0] if v else None
    return v


def spread(v):
    return v if isinstance(v, Multi) else (v,)


def adj(n, *vals):
    out = list(vals[:n])
    out += [None] * (n - len(out))
    return out


def truthy(v):
    if isinstance(v, Multi):
        v = v[0] if v else None
    return v is not None and v is not False


_TRUE, _FALSE = object(), object()


def _key(k):
    if k is True:
        return _TRUE
    if k is False:
        return _FALSE
    if isinstance(k, float) and k.is_integer():
        return int(k)
    return k


def _unkey(k):
    return True if k is _TRUE else False if k is _FALSE else k


class LuaTable:
    __slots__ = ('h', 'meta', '_n', '__dict__')

    def __init__(self, arr=None, hsh=None):
        self.h = {}
        self.meta = None
        self._n = 0
        if hsh:
            for k, v in hsh.items():
                if v is not None:
                    self.h[_key(k)] = v
        if arr:
            for i, v in enumerate(arr, 1):
                if v is not None:
                    self.h[i] = v

    def __getitem__(self, k):
        v = self.h.get(_key(k))
        if v is None and self.meta is not None:
            idx = self.meta.h.get('__index')
            if idx is not None:
                return idx[k] if isinstance(idx, LuaTable) else first(idx(self, k))
        return v

    def __setitem__(self, k, v):
        kk = _key(k)
        if kk is None:
            raise LuaError('table index is nil')
        if kk not in self.h and self.meta is not None:
            ni = self.meta.h.get('__newindex')
            if ni is not None:
                if isinstance(ni, LuaTable):
                    ni[k] = v
                else:
                    ni(self, k, v)
                return
        if v is None:
            self.h.pop(kk, None)
        else:
            self.h[kk] = v

    def length(self):
        # any border is a valid #t in Lua; the cached hint makes t[#t+1] = v amortized O(1)
        h, n = self.h, self._n
        if n > 0 and n not in h:
            while n > 0 and n not in h:
                n -= 1
        else:
            while (n + 1) in h:
                n += 1
        self._n = n
        return n

    def __call__(self, *a):
        f = self.meta.h.get('__call') if self.meta is not None else None
        if f is None:
            raise LuaError('attempt to call a table value')
        return f(self, *a)

    __hash__ = object.__hash__

    def __eq__(self, o):
        return self is o

    def __repr__(self):
        return 'LuaTable(%r)' % ({_unkey(k): v for k, v in self.h.items()},)


T = LuaTable


class _Lib(LuaTable):
    def __getattr__(self, name):
        try:
            return self.h[name]
        except KeyError:
            raise AttributeError(name)


def _lib(**fns):
    t = _Lib()
    t.h.update(fns)
    return t


def _num(x):
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        return x
    if isinstance(x, str):
        n = tonumber(x)
        if n is not None:
            return n
    raise LuaError('attempt to perform arithmetic on a %s value' % lua_type(x))


def _int(x):
    return int(_m.floor(_num(x)))


def mul(a, b):
    """a * b with IEEE-double rounding like Lua (exact Python ints would diverge past 2^53)"""
    r = a * b
    if isinstance(r, int) and not -9007199254740992 <= r <= 9007199254740992:
        return float(a) * float(b)
    return r


def lua_div(a, b):
    a, b = _num(a), _num(b)
    try:
        return a / b
    except ZeroDivisionError:
        if a == 0 or a != a:
            return float('nan')
        return float('inf') if (a > 0) == (_m.copysign(1, b) > 0) else float('-inf')


def lua_idiv(a, b):
    q = lua_div(a, b)
    return q if (q != q or q in (float('inf'), float('-inf'))) else _m.floor(q)


def lua_mod(a, b):
    a, b = _num(a), _num(b)
    if b == 0:
        return float('nan')
    if isinstance(a, int) and isinstance(b, int):
        return a % b
    r = _m.fmod(a, b)
    if r != 0 and (r < 0) != (b < 0):
        r += b
    return r


def lua_pow(a, b):
    try:
        return float(_num(a)) ** _num(b)
    except OverflowError:
        return float('inf')
    except ZeroDivisionError:
        return float('inf')


def _numstr(n):
    if isinstance(n, int):
        return str(n) if abs(n) < 10 ** 16 else repr(float(n))
    if n != n:
        return 'nan'
    if n in (float('inf'), float('-inf')):
        return 'inf' if n > 0 else '-inf'
    if n.is_integer() and abs(n) < 1e16:
        return str(int(n))
    return repr(n)


def tostring(v):
    v = first(v)
    if v is None:
        return 'nil'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, (int, float)):
        return _numstr(v)
    if isinstance(v, str):
        return v
    if isinstance(v, LuaTable):
        if v.meta is not None and v.meta.h.get('__tostring') is not None:
            return first(v.meta.h['__tostring'](v))
        return 'table: 0x%08x' % (id(v) & 0xffffffff)
    if callable(v):
        return 'function: 0x%08x' % (id(v) & 0xffffffff)
    return str(v)


def concat(*xs):
    out = []
    for x in xs:
        x = first(x)
        if isinstance(x, str):
            out.append(x)
        elif isinstance(x, (int, float)) and not isinstance(x, bool):
            out.append(_numstr(x))
        else:
            raise LuaError('attempt to concatenate a %s value' % lua_type(x))
    return ''.join(out)


def tonumber(v, base=None):
    v = first(v)
    if base is None:
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return v
        if not isinstance(v, str):
            return None
        s = v.strip()
        try:
            if _re.fullmatch(r'[+-]?0[xX][0-9a-fA-F]+', s):
                return int(s, 16)
            if _re.fullmatch(r'[+-]?\d+', s):
                return int(s)
            f = float(s)
            return int(f) if f.is_integer() and abs(f) < 2 ** 53 and 'e' not in s.lower() and '.' not in s else f
        except ValueError:
            return None
    try:
        return int(str(v).strip().lower(), int(base))
    except ValueError:
        return None


def lua_type(v):
    v = first(v)
    if v is None:
        return 'nil'
    if isinstance(v, bool):
        return 'boolean'
    if isinstance(v, (int, float)):
        return 'number'
    if isinstance(v, str):
        return 'string'
    if isinstance(v, LuaTable):
        return 'table'
    if isinstance(v, LuaBuffer):
        return 'buffer'
    if isinstance(v, LuaCoroutine):
        return 'thread'
    if callable(v):
        return 'function'
    return 'userdata'


def lua_len(v):
    if isinstance(v, str):
        return len(v)
    if isinstance(v, LuaTable):
        if v.meta is not None and v.meta.h.get('__len') is not None:
            return first(v.meta.h['__len'](v))
        return v.length()
    raise LuaError('attempt to get length of a %s value' % lua_type(v))


def lua_range(a, b, c=1):
    a, b, c = _num(a), _num(b), _num(c)
    if c == 0:
        raise LuaError("'for' step is zero")
    if isinstance(a, int) and isinstance(b, int) and isinstance(c, int):
        return range(a, b + (1 if c > 0 else -1), c)
    return _frange(a, b, c)


def _frange(a, b, c):
    i = a
    while (i <= b) if c > 0 else (i >= b):
        yield i
        i += c


def pairs(t):
    if isinstance(t, LuaTable):
        for k, v in list(t.h.items()):
            if t.h.get(k) is not None:
                yield _unkey(k), v
        return
    raise LuaError("bad argument #1 to 'pairs' (table expected)")


def ipairs(t):
    i = 1
    while True:
        v = t[i]
        if v is None:
            return
        yield i, v
        i += 1


def lua_next(t, k=None):
    keys = list(t.h.keys())
    if k is None:
        idx = 0
    else:
        kk = _key(k)
        idx = keys.index(kk) + 1 if kk in t.h else len(keys)
    if idx >= len(keys):
        return None
    return Multi((_unkey(keys[idx]), t.h[keys[idx]]))


def lua_iter(n, f, s=None, c=None):
    """generic-for protocol: for a, b in f, s, c (also accepts Python iterators)"""
    if hasattr(f, '__next__') or isinstance(f, (list, tuple, range)):
        for item in f:
            yield adj(n, *(item if isinstance(item, tuple) else (item,)))
        return
    if isinstance(f, LuaTable) and (f.meta is None or f.meta.h.get('__call') is None):
        # Luau generalized iteration (for k, v in t do): __iter, else the array part in order, then the hash part
        it = f.meta.h.get('__iter') if f.meta is not None else None
        if it is not None:
            f, s, c = (list(spread(it(f))) + [None, None, None])[:3]
        else:
            t = f
            seen = set()
            i = 1
            while t.h.get(_key(i)) is not None:
                seen.add(_key(i))
                yield adj(n, i, t.h.get(_key(i)))
                i += 1
            for k, v in list(t.h.items()):
                if k in seen or t.h.get(k) is None:
                    continue
                yield adj(n, _unkey(k), v)
            return
    while True:
        r = adj(n, *spread(f(s, c)))
        if r[0] is None:
            return
        c = r[0]
        yield r


def select(n, *a):
    if n == '#':
        return len(a)
    n = _int(n)
    if n < 0:
        n = len(a) + n + 1
    return Multi(a[n - 1:])


def lua_unpack(t, i=1, j=None):
    i = _int(i)
    j = lua_len(t) if j is None else _int(j)
    return Multi(t[k] for k in range(i, j + 1))


def lua_print(*a):
    s = '\t'.join(tostring(x) for x in a) + '\n'
    _sys.stdout.buffer.write(s.encode('latin-1', 'replace'))
    _sys.stdout.flush()


def lua_error(msg=None, level=1):
    raise LuaError(msg)


def lua_assert(v=None, msg='assertion failed!', *rest):
    if not truthy(v):
        raise LuaError(msg)
    return Multi((v, msg) + rest) if rest or msg != 'assertion failed!' else v


def pcall(f, *a):
    try:
        return Multi((True,) + tuple(spread(f(*a))))
    except LuaError as e:
        return Multi((False, e.value))
    except Exception as e:
        return Multi((False, str(e)))


def xpcall(f, handler, *a):
    try:
        return Multi((True,) + tuple(spread(f(*a))))
    except LuaError as e:
        return Multi((False, first(handler(e.value))))
    except Exception as e:
        return Multi((False, first(handler(str(e)))))


def setmetatable(t, mt):
    t.meta = mt
    return t


def getmetatable(t):
    if isinstance(t, LuaTable):
        mt = t.meta
        if mt is not None and mt.h.get('__metatable') is not None:
            return mt.h['__metatable']
        return mt
    if isinstance(t, str):
        return _lib(__index=string)
    return None


def rawget(t, k):
    return t.h.get(_key(k))


def rawset(t, k, v):
    kk = _key(k)
    if v is None:
        t.h.pop(kk, None)
    else:
        t.h[kk] = v
    return t


def rawequal(a, b):
    return a is b or (not isinstance(a, LuaTable) and a == b)


def rawlen(t):
    return len(t) if isinstance(t, str) else t.length()


def invoke(obj, name, *a):
    """obj:name(...) - strings dispatch to the string library"""
    if isinstance(obj, str):
        return string.h[name](obj, *a)
    return obj[name](obj, *a)


def _not_static(*_a):
    raise LuaError('dynamic code loading is not available in a static transpile')


# ------------------------------------------------------------------ string --
def _s_sub(s, i=1, j=-1):
    n = len(s)
    i = _int(i)
    j = -1 if j is None else _int(j)
    if i < 0:
        i = max(n + i + 1, 1)
    elif i == 0:
        i = 1
    if j < 0:
        j = n + j + 1
    elif j > n:
        j = n
    return s[i - 1:j] if i <= j else ''


def _s_byte(s, i=1, j=None):
    sub = _s_sub(s, i, i if j is None else j)
    if len(sub) == 1:
        return ord(sub)
    return Multi(ord(ch) for ch in sub)


def _s_char(*cs):
    return ''.join(chr(_int(c) & 0xff) for c in cs)


def _s_rep(s, n, *_):
    n = _int(n)
    return s * n if n > 0 else ''


def _ascii_case(s, upper):
    lo, hi = ('abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    return s.translate(str.maketrans(lo, hi) if upper else str.maketrans(hi, lo))


_CLS = {'a': 'A-Za-z', 'd': '0-9', 'l': 'a-z', 's': ' \\t\\n\\r\\f\\v', 'u': 'A-Z', 'w': 'A-Za-z0-9',
        'x': 'A-Fa-f0-9', 'p': '!-/:-@\\[-\x60{-~', 'c': '\\x00-\\x1f\\x7f', 'g': '!-~'}


def _lua_pat(p):
    """translate a Lua pattern into a Python regex (no %b / %f support)"""
    out, i, n, depth = [], 0, len(p), 0
    anchored = p.startswith('^')
    if anchored:
        i = 1
    while i < n:
        c = p[i]
        if c == '%':
            i += 1
            d = p[i]
            if d in _CLS:
                out.append('[' + _CLS[d] + ']')
            elif d.lower() in _CLS:
                out.append('[^' + _CLS[d.lower()] + ']')
            elif d.isdigit():
                out.append('\\' + d)
            elif d in 'bf':
                raise LuaError('pattern item %' + d + ' is not supported by the transpiler')
            else:
                out.append(_re.escape(d))
        elif c == '[':
            j = i + 1
            cls = '['
            if j < n and p[j] == '^':
                cls += '^'
                j += 1
            first_ = True
            while j < n and (p[j] != ']' or first_):
                first_ = False
                if p[j] == '%':
                    j += 1
                    d = p[j]
                    cls += _CLS.get(d, '') if d in _CLS else ('' if d.lower() in _CLS else _re.escape(d))
                elif p[j] in '\\[]^':
                    cls += '\\' + p[j]
                else:
                    cls += p[j]
                j += 1
            out.append(cls + ']')
            i = j
        elif c == '(':
            if i + 1 < n and p[i + 1] == ')':
                out.append('()')
                i += 1
            else:
                out.append('(')
                depth += 1
        elif c == ')':
            out.append(')')
            depth -= 1
        elif c == '.':
            out.append('[\\s\\S]')
        elif c == '-':
            if out:
                out.append('*?')
            else:
                out.append('\\-')
        elif c in '*+?':
            out.append(c)
        elif c == '$' and i == n - 1:
            out.append('\\Z')
        else:
            out.append(_re.escape(c))
        i += 1
    return ('^' if anchored else '') + ''.join(out)


def _caps(m):
    if m.re.groups == 0:
        return (m.group(0),)
    return tuple((m.start(g) + 1 if m.group(g) == '' and m.re.pattern.find('()') >= 0 else m.group(g)) for g in range(1, m.re.groups + 1))


def _s_find(s, p, init=1, plain=False):
    init = _int(init)
    if init < 0:
        init = max(len(s) + init + 1, 1)
    elif init == 0:
        init = 1
    if plain or not _re.search(r'[\^$*+?.()\[\]%-]', p):
        k = s.find(p, init - 1)
        return None if k < 0 else Multi((k + 1, k + len(p)))
    m = _re.compile(_lua_pat(p)).search(s, init - 1)
    if not m:
        return None
    return Multi((m.start() + 1, m.end()) + (_caps(m) if m.re.groups else ()))


def _s_match(s, p, init=1):
    init = _int(init)
    if init < 0:
        init = max(len(s) + init + 1, 1)
    m = _re.compile(_lua_pat(p)).search(s, max(init, 1) - 1)
    if not m:
        return None
    c = _caps(m)
    return c[0] if len(c) == 1 else Multi(c)


def _s_gmatch(s, p):
    for m in _re.compile(_lua_pat(p)).finditer(s):
        c = _caps(m)
        yield c


def _s_gsub(s, p, repl, n=None):
    rx = _re.compile(_lua_pat(p))
    count = [0]
    lim = None if n is None else _int(n)

    def sub(m):
        if lim is not None and count[0] >= lim:
            return m.group(0)
        count[0] += 1
        c = _caps(m)
        if isinstance(repl, str):
            def rep(mm):
                d = mm.group(1)
                if d == '%':
                    return '%'
                k = int(d)
                return m.group(0) if k == 0 else tostring(c[k - 1])
            return _re.sub(r'%([0-9%])', rep, repl)
        v = repl[c[0]] if isinstance(repl, LuaTable) else first(repl(*c))
        if v is None or v is False:
            return m.group(0)
        return tostring(v)
    out = rx.sub(sub, s)
    return Multi((out, count[0]))


def _s_format(fmt, *args):
    args = list(args)
    pos = [0]

    def nxt():
        v = args[pos[0]] if pos[0] < len(args) else None
        pos[0] += 1
        return v

    def rep(m):
        flags, conv = m.group(1), m.group(2)
        if conv == '%':
            return '%'
        v = nxt()
        if conv in 'di':
            return ('%' + flags + 'd') % _int(v)
        if conv in 'xXo':
            return ('%' + flags + conv) % (_int(v) & 0xffffffffffffffff if _int(v) < 0 else _int(v))
        if conv == 'c':
            return chr(_int(v))
        if conv == 's':
            return ('%' + flags + 's') % tostring(v)
        if conv == 'q':
            return '"' + tostring(v).replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\\n').replace('\r', '\\r').replace('\0', '\\000') + '"'
        if conv in 'eEfgG':
            return ('%' + flags + conv) % float(_num(v))
        if conv == 'u':
            return ('%' + flags + 'd') % _int(v)
        return m.group(0)
    return _re.sub(r'%([-+ #0]*\d*(?:\.\d+)?)([diouxXeEfgGcsq%])', rep, fmt)


def _s_split(s, sep=','):
    return T(s.split(sep))


string = _lib(sub=_s_sub, byte=_s_byte, char=_s_char, len=len, rep=_s_rep, reverse=lambda s: s[::-1],
              lower=lambda s: _ascii_case(s, False), upper=lambda s: _ascii_case(s, True), find=_s_find,
              match=_s_match, gmatch=_s_gmatch, gsub=_s_gsub, format=_s_format, split=_s_split)


# ------------------------------------------------------------------- table --
def _t_insert(t, a, b=None, *rest):
    if b is None and not rest:
        t[t.length() + 1] = a
        return
    pos, v, n = _int(a), b, t.length()
    for k in range(n, pos - 1, -1):
        t[k + 1] = t[k]
    t[pos] = v


def _t_remove(t, pos=None):
    n = t.length()
    if n == 0 and pos is None:
        return None
    pos = n if pos is None else _int(pos)
    v = t[pos]
    for k in range(pos, n):
        t[k] = t[k + 1]
    if pos <= n:
        t[n] = None
    return v


def _t_concat(t, sep='', i=1, j=None):
    j = t.length() if j is None else _int(j)
    return sep.join(concat(t[k]) for k in range(_int(i), j + 1))


def _t_sort(t, comp=None):
    n = t.length()
    items = [t[k] for k in range(1, n + 1)]
    if comp is None:
        items.sort()
    else:
        items.sort(key=_cmp_to_key(lambda a, b: -1 if truthy(comp(a, b)) else (1 if truthy(comp(b, a)) else 0)))
    for k, v in enumerate(items, 1):
        t[k] = v


def _t_pack(*a):
    t = T(list(a))
    t['n'] = len(a)
    return t


def _t_find(t, v, init=1):
    k = _int(init)
    while t[k] is not None:
        if t[k] == v:
            return k
        k += 1
    return None


def _t_create(n, v=None):
    return T([v] * _int(n))


def _t_clear(t):
    t.h.clear()


def _t_move(a1, f, e, t, a2=None):
    a2 = a1 if a2 is None else a2
    f, e, t = _int(f), _int(e), _int(t)
    if e >= f:
        if t > f or t > e or a1 is not a2:
            for k in range(0, e - f + 1):
                a2[t + k] = a1[f + k]
        else:
            for k in range(e - f, -1, -1):
                a2[t + k] = a1[f + k]
    return a2


table = _lib(insert=_t_insert, remove=_t_remove, concat=_t_concat, unpack=lua_unpack, pack=_t_pack, sort=_t_sort,
             find=_t_find, create=_t_create, clear=_t_clear, move=_t_move, getn=lambda t: t.length())


# -------------------------------------------------------------------- math --
def _floor(x):
    x = _num(x)
    return _m.floor(x) if _m.isfinite(x) else x


def _ceil(x):
    x = _num(x)
    return _m.ceil(x) if _m.isfinite(x) else x


def _modf(x):
    x = float(_num(x))
    f, i = _m.modf(x)
    return Multi((float(i), f))


def _log(x, b=None):
    x = _num(x)
    if x == 0:
        return float('-inf')
    return _m.log(x) if b is None else _m.log(x, _num(b))


def _m_random(a=None, b=None):
    if a is None:
        return _random_mod.random()
    if b is None:
        return _random_mod.randint(1, _int(a))
    return _random_mod.randint(_int(a), _int(b))


_random_mod = _rnd.Random(0)
math = _lib(floor=_floor, ceil=_ceil, abs=abs, max=max, min=min, sqrt=lambda x: _m.sqrt(_num(x)), huge=float('inf'),
            pi=_m.pi, fmod=lambda a, b: _m.fmod(_num(a), _num(b)), modf=_modf, log=_log, log10=lambda x: _m.log10(x),
            exp=_m.exp, sin=_m.sin, cos=_m.cos, tan=_m.tan, asin=_m.asin, acos=_m.acos, atan=lambda y, x=None: _m.atan(y) if x is None else _m.atan2(y, x),
            atan2=_m.atan2, sinh=_m.sinh, cosh=_m.cosh, tanh=_m.tanh, pow=lambda a, b: lua_pow(a, b), deg=_m.degrees, rad=_m.radians,
            random=_m_random, randomseed=lambda s=0: _random_mod.seed(s), frexp=lambda x: Multi(_m.frexp(x)), ldexp=lambda m, e: _m.ldexp(m, _int(e)),
            clamp=lambda x, lo, hi: max(lo, min(hi, x)), sign=lambda x: (x > 0) - (x < 0), round=lambda x: _m.floor(x + 0.5) if x >= 0 else _m.ceil(x - 0.5),
            tointeger=lambda x: int(x) if isinstance(x, (int, float)) and float(x).is_integer() else None, maxinteger=2 ** 63 - 1, mininteger=-2 ** 63)


# ------------------------------------------------------------------- bit32 --
_M32 = 0xffffffff


def _u32(x):
    return _int(x) & _M32


def _band(*a):
    r = _M32
    for x in a:
        r &= _u32(x)
    return r


def _bor(*a):
    r = 0
    for x in a:
        r |= _u32(x)
    return r


def _bxor(*a):
    r = 0
    for x in a:
        r ^= _u32(x)
    return r


def _lshift(x, n):
    n = _int(n)
    return 0 if abs(n) >= 32 else ((_u32(x) << n) & _M32 if n >= 0 else _u32(x) >> -n)


def _rshift(x, n):
    n = _int(n)
    return 0 if abs(n) >= 32 else (_u32(x) >> n if n >= 0 else (_u32(x) << -n) & _M32)


def _arshift(x, n):
    x, n = _u32(x), _int(n)
    if x & 0x80000000:
        x -= 1 << 32
    return (x >> n) & _M32 if n >= 0 else (x << -n) & _M32


def _lrotate(x, n):
    x, n = _u32(x), _int(n) % 32
    return ((x << n) | (x >> (32 - n))) & _M32


def _extract(x, f, w=1):
    return (_u32(x) >> _int(f)) & ((1 << _int(w)) - 1)


def _replace(x, v, f, w=1):
    f, w = _int(f), _int(w)
    mask = ((1 << w) - 1) << f
    return (_u32(x) & ~mask | (_u32(v) << f) & mask) & _M32


def _countlz(x):
    x = _u32(x)
    return 32 - x.bit_length()


def _countrz(x):
    x = _u32(x)
    return 32 if x == 0 else (x & -x).bit_length() - 1


bit32 = _lib(band=_band, bor=_bor, bxor=_bxor, bnot=lambda x: ~_u32(x) & _M32, lshift=_lshift, rshift=_rshift, arshift=_arshift,
             lrotate=_lrotate, rrotate=lambda x, n: _lrotate(x, -_int(n)), extract=_extract, replace=_replace,
             btest=lambda *a: _band(*a) != 0, countlz=_countlz, countrz=_countrz,
             byteswap=lambda x: int.from_bytes(_u32(x).to_bytes(4, 'little'), 'big'))
utf8 = _lib(char=lambda *cs: ''.join(chr(b) for c in cs for b in chr(_int(c)).encode('utf-8')), charpattern='[\x00-\x7F\xC2-\xFD][\x80-\xBF]*')
os = _lib(time=lambda t=None: int(_time.time()), clock=_time.process_time, date=lambda f='%c', t=None: _time.strftime(f.lstrip('!'), _time.gmtime(t)))

# ------------------------------------------------- string.pack / unpack --
import struct as _struct


def _pk_tokens(fmt):
    fmt = first(fmt)
    i, n, little, out = 0, len(fmt), True, []

    def num(default):
        nonlocal i
        j = i
        while i < n and fmt[i].isdigit():
            i += 1
        return int(fmt[j:i]) if i > j else default
    while i < n:
        c = fmt[i]
        i += 1
        if c in '<=':
            little = True
        elif c == '>':
            little = False
        elif c == '!':
            num(8)
        elif c == ' ':
            pass
        elif c in 'bB':
            out.append(('i', 1, c == 'b', little))
        elif c in 'hH':
            out.append(('i', 2, c == 'h', little))
        elif c in 'lj':
            out.append(('i', 8, True, little))
        elif c in 'LJT':
            out.append(('i', 8, False, little))
        elif c in 'iI':
            out.append(('i', num(4), c == 'i', little))
        elif c == 'f':
            out.append(('f', 4, None, little))
        elif c in 'dn':
            out.append(('f', 8, None, little))
        elif c == 's':
            out.append(('s', num(8), None, little))
        elif c == 'z':
            out.append(('z', 0, None, little))
        elif c == 'x':
            out.append(('x', 1, None, little))
        elif c == 'c':
            out.append(('c', num(-1), None, little))
        elif c == 'X':
            if i < n:
                i += 1
        else:
            raise LuaError("invalid format option '%s'" % c)
    return out


def _pk_int(v, size, signed, little):
    x = int(_num(v)) & ((1 << (8 * size)) - 1)
    return x.to_bytes(size, 'little' if little else 'big')


def _s_pack(fmt, *vals):
    out, k = bytearray(), 0
    for kind, size, signed, little in _pk_tokens(fmt):
        if kind == 'x':
            out += b'\0'
            continue
        v = vals[k] if k < len(vals) else None
        k += 1
        if kind == 'i':
            out += _pk_int(v, size, signed, little)
        elif kind == 'f':
            out += _struct.pack(('<' if little else '>') + ('f' if size == 4 else 'd'), float(_num(v)))
        elif kind == 's':
            b = str(v).encode('latin-1')
            out += _pk_int(len(b), size, False, little) + b
        elif kind == 'z':
            out += str(v).encode('latin-1') + b'\0'
        elif kind == 'c':
            b = str(v).encode('latin-1')
            out += b if size < 0 else (b + b'\0' * size)[:size]
    return out.decode('latin-1')


def _s_packsize(fmt):
    total = 0
    for kind, size, _s, _l in _pk_tokens(fmt):
        if kind in 'sz':
            raise LuaError('variable-length format in packsize')
        total += max(size, 0)
    return total


def _s_unpack(fmt, s, pos=1):
    data, p, res = first(s).encode('latin-1'), _int(pos) - 1, []
    if p < 0:
        p += len(data) + 1
    for kind, size, signed, little in _pk_tokens(fmt):
        if kind == 'x':
            p += 1
            continue
        if kind == 'z':
            e = data.index(b'\0', p)
            res.append(data[p:e].decode('latin-1'))
            p = e + 1
            continue
        if kind == 's':
            ln = int.from_bytes(data[p:p + size], 'little' if little else 'big')
            p += size
            if p + ln > len(data):
                raise LuaError('data string too short')
            res.append(data[p:p + ln].decode('latin-1'))
            p += ln
            continue
        if kind == 'c':
            size = len(data) - p if size < 0 else size
        if p + size > len(data):
            raise LuaError('data string too short')
        chunk = data[p:p + size]
        p += size
        if kind == 'i':
            v = int.from_bytes(chunk, 'little' if little else 'big', signed=signed)
            res.append(float(v) if abs(v) > 9007199254740992 else v)
        elif kind == 'f':
            res.append(_struct.unpack(('<' if little else '>') + ('f' if size == 4 else 'd'), chunk)[0])
        else:
            res.append(chunk.decode('latin-1'))
    res.append(p + 1)
    return Multi(tuple(res))


string.h['pack'] = _s_pack
string.h['unpack'] = _s_unpack
string.h['packsize'] = _s_packsize


# --------------------------------------------------------- buffer (Luau) --
class LuaBuffer:
    __slots__ = ('b',)

    def __init__(self, n=0, data=None):
        self.b = bytearray(data) if data is not None else bytearray(int(_num(n)))

    def __repr__(self):
        return 'buffer: 0x%08x' % (id(self) & 0xffffffff)


def _bof(b, off, n):
    if not isinstance(b, LuaBuffer):
        raise LuaError('invalid argument #1 (buffer expected, got %s)' % lua_type(b))
    off = int(_num(off))
    if off < 0 or off + n > len(b.b):
        raise LuaError('buffer access out of bounds')
    return off


def _b_rd(code, n):
    return lambda b, off: _struct.unpack_from('<' + code, b.b, _bof(b, off, n))[0]


def _b_wint(code, n):
    bits = 8 * n

    def w(b, off, v):
        x = int(_num(v)) & ((1 << bits) - 1)
        if code.islower() and x >= 1 << (bits - 1):
            x -= 1 << bits
        _struct.pack_into('<' + code, b.b, _bof(b, off, n), x)
    return w


def _b_wflt(code, n):
    def w(b, off, v):
        _struct.pack_into('<' + code, b.b, _bof(b, off, n), float(_num(v)))
    return w


def _b_readstring(b, off, count):
    count = int(_num(count))
    o = _bof(b, off, count)
    return bytes(b.b[o:o + count]).decode('latin-1')


def _b_writestring(b, off, s, count=None):
    data = first(s).encode('latin-1')
    if count is not None:
        data = data[:int(_num(count))]
    o = _bof(b, off, len(data))
    b.b[o:o + len(data)] = data


def _b_copy(target, toff, source, soff=0, count=None):
    soff = int(_num(soff or 0))
    count = len(source.b) - soff if count is None else int(_num(count))
    _bof(source, soff, count)
    o = _bof(target, toff, count)
    target.b[o:o + count] = source.b[soff:soff + count]


def _b_fill(b, off, value, count=None):
    off = int(_num(off))
    count = len(b.b) - off if count is None else int(_num(count))
    o = _bof(b, off, count)
    b.b[o:o + count] = bytes([int(_num(value)) & 255]) * count


def _b_readbits(b, bitoff, bitcount):
    bitoff, bitcount = int(_num(bitoff)), int(_num(bitcount))
    v = int.from_bytes(bytes(b.b), 'little')
    return (v >> bitoff) & ((1 << bitcount) - 1)


def _b_writebits(b, bitoff, bitcount, value):
    bitoff, bitcount = int(_num(bitoff)), int(_num(bitcount))
    v = int.from_bytes(bytes(b.b), 'little')
    mask = ((1 << bitcount) - 1) << bitoff
    v = (v & ~mask) | ((int(_num(value)) << bitoff) & mask)
    b.b[:] = v.to_bytes(len(b.b), 'little')


buffer = _lib(create=lambda n: LuaBuffer(n), fromstring=lambda s: LuaBuffer(data=first(s).encode('latin-1')),
              tostring=lambda b: bytes(b.b).decode('latin-1'), len=lambda b: len(b.b),
              readi8=_b_rd('b', 1), readu8=_b_rd('B', 1), readi16=_b_rd('h', 2), readu16=_b_rd('H', 2),
              readi32=_b_rd('i', 4), readu32=_b_rd('I', 4), readf32=_b_rd('f', 4), readf64=_b_rd('d', 8),
              writei8=_b_wint('b', 1), writeu8=_b_wint('B', 1), writei16=_b_wint('h', 2), writeu16=_b_wint('H', 2),
              writei32=_b_wint('i', 4), writeu32=_b_wint('I', 4), writef32=_b_wflt('f', 4), writef64=_b_wflt('d', 8),
              readstring=_b_readstring, writestring=_b_writestring, copy=_b_copy, fill=_b_fill,
              readbits=_b_readbits, writebits=_b_writebits)


# ---------------------------------------------- coroutine (thread-backed) --
import threading as _th
try:
    _th.stack_size(512 * 1024 * 1024)
except Exception:
    pass


class LuaCoroutine:
    __slots__ = ('fn', 'status', 'transfer', 'resume_ev', 'yield_ev', 'thread', 'done')

    def __init__(self, fn):
        self.fn, self.status, self.transfer, self.thread, self.done = fn, 'suspended', (), None, False
        self.resume_ev, self.yield_ev = _th.Semaphore(0), _th.Semaphore(0)

    def __repr__(self):
        return 'thread: 0x%08x' % (id(self) & 0xffffffff)


_co_stack = []


def _co_start(co):
    def body():
        co.resume_ev.acquire()
        try:
            co.transfer = (True,) + tuple(spread(co.fn(*co.transfer)))
        except LuaError as e:
            co.transfer = (False, e.value)
        except Exception as e:
            co.transfer = (False, '%s: %s' % (type(e).__name__, e))
        co.done, co.status = True, 'dead'
        co.yield_ev.release()
    co.thread = _th.Thread(target=body, daemon=True)
    co.thread.start()


def _co_resume(co, *args):
    if not isinstance(co, LuaCoroutine):
        raise LuaError('bad argument #1 to resume (thread expected)')
    if co.status == 'dead':
        return Multi((False, 'cannot resume dead coroutine'))
    if co.status != 'suspended':
        return Multi((False, 'cannot resume non-suspended coroutine'))
    prev = _co_stack[-1] if _co_stack else None
    if prev is not None:
        prev.status = 'normal'
    co.status, co.transfer = 'running', args
    _co_stack.append(co)
    if co.thread is None:
        _co_start(co)
    co.resume_ev.release()
    co.yield_ev.acquire()
    _co_stack.pop()
    if prev is not None:
        prev.status = 'running'
    if co.done:
        return Multi(co.transfer)
    co.status = 'suspended'
    return Multi((True,) + tuple(co.transfer))


def _co_yield(*vals):
    co = _co_stack[-1] if _co_stack else None
    if co is None:
        raise LuaError('attempt to yield from outside a coroutine')
    co.transfer = vals
    co.yield_ev.release()
    co.resume_ev.acquire()
    return Multi(tuple(co.transfer))


def _co_wrap(fn):
    co = LuaCoroutine(fn)

    def f(*a):
        r = _co_resume(co, *a)
        if not r[0]:
            raise LuaError(r[1] if len(r) > 1 else None)
        return Multi(tuple(r[1:]))
    return f


coroutine = _lib(create=lambda fn: LuaCoroutine(fn), resume=_co_resume, yield_=None, status=lambda co: co.status,
                 wrap=_co_wrap, running=lambda: _co_stack[-1] if _co_stack else None,
                 isyieldable=lambda: bool(_co_stack), close=lambda co: True)
coroutine.h.pop('yield_', None)
coroutine.h['yield'] = _co_yield


# globals table seen by the script (_G / getfenv()); unknown globals are nil
G = _lib(string=string, table=table, math=math, bit32=bit32, utf8=utf8, os=os, print=lua_print, tostring=tostring,
         tonumber=tonumber, type=lua_type, pairs=pairs, ipairs=ipairs, next=lua_next, select=select, unpack=lua_unpack,
         error=lua_error, pcall=pcall, xpcall=xpcall, setmetatable=setmetatable, getmetatable=getmetatable,
         rawget=rawget, rawset=rawset, rawequal=rawequal, rawlen=rawlen, loadstring=_not_static, load=_not_static)
G.h['_G'] = G
G.h['buffer'] = buffer
G.h['coroutine'] = coroutine
G.h['typeof'] = lambda v: lua_type(v)
G.h['assert'] = lua_assert
getfenv = lambda *a: G
setfenv = lambda f, env=None: f


def lua_dump(v, path=None, indent=1):
    """Print (or save to path) any Lua value as JSON: tables -> list/dict, non-text strings ->
    {"$bytes": hex}, functions -> "<function>", cycles -> "<cycle>". Returns the JSON text."""
    import json as _json
    seen = set()

    def conv(x):
        if isinstance(x, Multi):
            return [conv(e) for e in x]
        if isinstance(x, LuaTable):
            if id(x) in seen:
                return '<cycle>'
            seen.add(id(x))
            n = x.length()
            if n and len(x.h) == n:
                out = [conv(x.h.get(i)) for i in range(1, n + 1)]
            else:
                out = {}
                for k, val in x.h.items():
                    k = _unkey(k)
                    out[k if isinstance(k, str) else tostring(k) if not isinstance(k, LuaTable) else '<table>'] = conv(val)
            seen.discard(id(x))
            return out
        if isinstance(x, dict):
            return {str(k): conv(e) for k, e in x.items()}
        if isinstance(x, (list, tuple)):
            return [conv(e) for e in x]
        if isinstance(x, str):
            return x if all(32 <= ord(c) < 127 or c in '\t\n\r' for c in x) else {'$bytes': x.encode('latin-1', 'replace').hex()}
        if x is None or isinstance(x, (bool, int, float)):
            return x
        if callable(x):
            return '<function>'
        return repr(x)

    s = _json.dumps(conv(v), indent=indent, ensure_ascii=False)
    if path:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(s)
    else:
        print(s)
    return s

# ----------------------------------------------------------- end of shim --
`;
