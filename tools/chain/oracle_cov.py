# Coverage of an expected output trace (oracle) by the decoded constants of a dump.
# Universal: any dump in PRISM format + any text file with expected lines (print("...") or raw lines).
import json, re, sys

dump_path, oracle_path = sys.argv[1], sys.argv[2]
D = json.load(open(dump_path))
if len(sys.argv) > 3:  # restrict to one dump key (e.g. the chunk root), ignoring loader tables
    D = D[sys.argv[3]]
S = set()

def walk(v):
    if isinstance(v, str):
        S.add(v)
    elif isinstance(v, list):
        for x in v: walk(x)
    elif isinstance(v, dict):
        if '$bytes' in v and isinstance(v['$bytes'], str):
            S.add(v['$bytes'])
        for k, x in v.items():
            if not k.startswith('$') or k in ('$arr', '$map', '$meta'):
                walk(x)
walk(D)
S = {s for s in S if s}

lines = []
for l in open(oracle_path, encoding='utf8', errors='replace'):
    m = re.match(r'\s*print\("(.*)"\)\s*$', l)
    if m:
        lines.append(m.group(1).encode().decode('unicode_escape'))

whole = sum(1 for l in lines if l in S)
cov_chars = tot_chars = 0
rep = []
for l in lines:
    # greedy longest literal cover (prefer longer constants)
    mark = [False] * len(l)
    for s in sorted(S, key=len, reverse=True):
        if len(s) < 2 and not s.strip():
            continue
        start = 0
        while True:
            i = l.find(s, start)
            if i < 0: break
            if not any(mark[i:i + len(s)]):
                for j in range(i, i + len(s)): mark[j] = True
            start = i + 1
    c = sum(mark)
    cov_chars += c; tot_chars += len(l)
    gaps = ''.join(ch if not mk else '·' for ch, mk in zip(l, mark))
    rep.append((c / max(1, len(l)), l, gaps))

words = sorted({w for l in lines for w in re.findall(r'[A-Za-z][A-Za-z!:]{2,}', l)})
missing = [w for w in words if not any(w in s for s in S)]
print(f'word coverage (words >= 3 letters found inside some decoded constant): {len(words) - len(missing)}/{len(words)}')
print('missing words:', ' '.join(missing) if missing else '-')
print(f'oracle lines: {len(lines)}; whole-line literals: {whole}; char coverage by constants: {cov_chars}/{tot_chars} = {100*cov_chars/max(1,tot_chars):.1f}%')
print(f'distinct decoded strings in dump: {len(S)}')
print('--- lines (· = covered by a decoded constant; visible chars = computed at runtime) ---')
for r, l, g in rep:
    print(f'{100*r:5.1f}%  {g}')
