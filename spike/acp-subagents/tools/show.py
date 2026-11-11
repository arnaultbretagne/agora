# Spike only: one scenario's lines, one per row: time, direction, session (P = parent, C1… = children), kind, a short body.
import json, sys
path, label = sys.argv[1], sys.argv[2]
width = int(sys.argv[3]) if len(sys.argv) > 3 else 220
names = {}
rows = [json.loads(l) for l in open(path)]
rows = [r for r in rows if r['label'].split('#')[0] == label]
def name(s):
    if s is None: return '-'
    if s not in names: names[s] = 'P' if not names else 'C%d' % len(names)
    return names[s]
for r in rows:
    m = json.loads(r['line']); p = m.get('params') or {}; u = p.get('update') or {}
    s = p.get('sessionId')
    if r['dir'] == 'in' and isinstance(m.get('result'), dict) and m['result'].get('sessionId'): s = m['result']['sessionId']
    k = u.get('sessionUpdate') or m.get('method') or ('result' if 'result' in m else 'error')
    body = dict(u); body.pop('sessionUpdate', None)
    if k == 'subagent_update': body['child'] = name(body.pop('sessionId'))
    for f in ('senderSessionId', 'recipientSessionId'):
        if f in body: body[f] = name(body[f])
    if k in ('available_commands_update',): body = {'availableCommands': '[%d]' % len(u.get('availableCommands', []))}
    if k in ('config_option_update',): body = {'ids': [o.get('id') for o in u.get('configOptions', [])]}
    if not u: body = {kk: vv for kk, vv in m.items() if kk not in ('jsonrpc',)}
    print('%7d %-3s %-3s %-26s %s' % (r['t'], r['dir'], name(s), k, json.dumps(body, ensure_ascii=False)[:width]))
