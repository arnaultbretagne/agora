# Spike only: per scenario, when the prompt was answered and what of its session tree came after that answer.
import json, sys
for path in sys.argv[1:]:
    rows = [json.loads(l) for l in open(path)]
    prompts = {}
    for r in rows:
        m = json.loads(r['line'])
        if r['dir'] == 'out' and m.get('method') == 'session/prompt':
            prompts[m['id']] = (r['label'].split('#')[0], m['params']['sessionId'], r['t'])
    for pid, (label, parent, t0) in prompts.items():
        tree = {parent}; answered = None; late = []
        for r in rows:
            m = json.loads(r['line'])
            if r['dir'] == 'in' and m.get('id') == pid and 'method' not in m:
                answered = (r['t'], (m.get('result') or {}).get('stopReason'))
                continue
            p = m.get('params') or {}; u = p.get('update') or {}
            if u.get('sessionUpdate') == 'subagent_update' and p.get('sessionId') in tree: tree.add(u.get('sessionId'))
            if r['dir'] == 'in' and answered and p.get('sessionId') in tree and m.get('method'):
                k = u.get('sessionUpdate') or m['method']
                if k in ('usage_update', 'available_commands_update'): continue
                late.append((r['t'], 'P' if p['sessionId'] == parent else 'C', k))
        kinds = {}
        for t, who, k in late: kinds[who + ':' + k] = kinds.get(who + ':' + k, 0) + 1
        span = (late[-1][0] - answered[0]) if late and answered else 0
        print('%-22s %-28s answered %6sms %-10s after it: %3d lines over %6d ms %s' % (path.split('/')[-1][:-6], label, answered[0] if answered else '-', answered[1] if answered else '-', len(late), span, json.dumps(kinds)))
