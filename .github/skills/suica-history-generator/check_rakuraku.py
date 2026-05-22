import json
t = json.load(open('out/may-rakuraku.json', encoding='utf-8'))
print(f'Total trips: {len(t)}')
print(f'Total yen: {sum(x["amount"] for x in t):,}')
print('First 5:')
for x in t[:5]: print(' ', x)
print('Last 3:')
for x in t[-3:]: print(' ', x)
