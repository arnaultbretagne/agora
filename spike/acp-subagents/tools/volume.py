# Spike only: per scenario, the lines and bytes of the parent's session against its children's, from the prompt on
# (late lines included), the announcements on the parent's stream counted apart.
import json, sys
for path in sys.argv[1:]:
    rows = [json.loads(l) for l in open(path)]
    for r0 in rows:
        m0 = json.loads(r0['line'])
        if not (r0['dir'] == 'out' and m0.get('method') == 'session/prompt'): continue
        parent = m0['params']['sessionId']; tree = {parent}
        P = [0, 0]; C = {}; A = [0, 0]
        for r in rows:
            if r['seq'] < r0['seq']: continue
            m = json.loads(r['line']); p = m.get('params') or {}; u = p.get('update') or {}
            s = p.get('sessionId'); b = len(r['line'].encode())
            if u.get('sessionUpdate') == 'subagent_update' and s in tree:
                tree.add(u['sessionId']); A[0] += 1; A[1] += b; continue
            if s == parent or (r['dir'] == 'in' and m.get('id') == m0['id']): P[0] += 1; P[1] += b
            elif s in tree:
                c = C.setdefault(s, [0, 0]); c[0] += 1; c[1] += b
        if not C and 'baseline' not in path: continue
        kids = ' '.join('%d/%.1fK' % (v[0], v[1] / 1024) for v in C.values())
        tot = sum(v[1] for v in C.values())
        print('%-16s %-28s parent %3d lines %5.1fK | children %-34s | announcements on parent %2d lines %4.1fK | children/parent bytes %.2f' % (path.split('/')[-1][:-6], r0['label'].split('#')[0], P[0], P[1] / 1024, kids or '-', A[0], A[1] / 1024, (tot + A[1]) / P[1] if P[1] else 0))
