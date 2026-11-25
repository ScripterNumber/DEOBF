import re, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
src_path, out_path = sys.argv[1], sys.argv[2]
L = open(src_path).read().split('\n')
start = next(i for i, l in enumerate(L) if l.strip() == 'import sys as _psys, json as _pjson')
end = next(i for i in range(start, len(L)) if L[i].strip() == '_pos._exit(0)')
ind = L[start][:len(L[start]) - len(L[start].lstrip())]
# names visible in the old hook's dump line: _pdump = {"arg364": _prism_conv(arg364), ...}
dump_line = next(l for l in L[start:end] if l.strip().startswith('_pdump = '))
pairs = re.findall(r'"([^"]+)": _prism_conv\(([A-Za-z_][A-Za-z_0-9]*)\)', dump_line)
# the factory's own parameters: the def line right above the hook
def_line = next(L[i] for i in range(start - 1, -1, -1) if L[i].lstrip().startswith('def '))
def_params = re.findall(r'([A-Za-z_][A-Za-z_0-9]*)=None', def_line)
params = [p for p in pairs if p[1] in def_params]
params.sort(key=lambda p: def_params.index(p[1]))
tables = [p for p in pairs if p[1] not in def_params]
root_py = params[0][1]
hook = [
    'import builtins as _pb',
    "if not getattr(_pb, '_prism_chain_n', 0):",
    '    _pb._prism_chain_n = 1',
    "    _pctx = {'root': %s, 'params': {%s}, 'tables': {%s}, 'post': _prism_post}" % (
        root_py, ', '.join('%r: %s' % (n, p) for n, p in params), ', '.join('%r: %s' % (n, p) for n, p in tables)),
    '    def _prism_stub(*_pa):',
    '        return _prism_chain(_pa, _pctx)',
    '    return _prism_stub',
]
L[start:end + 1] = [ind + h for h in hook]
main_at = next(i for i, l in enumerate(L) if l.startswith("if __name__ == '__main__':"))
rt = open(os.path.join(HERE, 'chain_rt.py')).read().split('\n') + open(os.path.join(HERE, 'lazy_rt.py')).read().split('\n')
L[main_at:main_at] = rt + ['', '']
open(out_path, 'w').write('\n'.join(L))
print('hook lines', start, end, 'params', params, 'tables', tables)
