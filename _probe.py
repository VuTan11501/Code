import urllib.request, json, os
req = urllib.request.Request(
    'https://api.github.com/gists/abc2a47c0a396025a72a6580227ff493',
    headers={'Authorization': f"Bearer {os.environ['GH_PAT']}"})
g = json.loads(urllib.request.urlopen(req).read())
c = json.loads(g['files']['ot-requests.json']['content'])
print('Top-level type:', type(c).__name__)
if isinstance(c, dict):
    for k, v in c.items():
        print(f'  {k}: {len(v) if isinstance(v, list) else v}')
    reqs = c.get('requests', [])
else:
    reqs = c
may = [r for r in reqs if r.get('date', '').startswith('2026-05')]
total = sum(r.get('hours', 0) for r in may)
print(f'May raw entries (all statuses): {len(may)}, hours: {total}')
print('--- May entries ---')
for r in sorted(may, key=lambda x: x['date']):
    print(f"  {r.get('date')} {r.get('start')}->{r.get('end')} "
          f"{r.get('hours')}h status={r.get('status','?')} "
          f"kintai={r.get('kintai_created_at','-')}")
