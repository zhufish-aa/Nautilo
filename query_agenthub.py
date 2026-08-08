# -*- coding: utf-8 -*-
import sqlite3, sys, json

DB = r'file:C:/Users/admin/AppData/Roaming/@agenthub/desktop/agenthub.sqlite?mode=ro'
con = sqlite3.connect(DB, uri=True)
con.text_factory = bytes
cur = con.cursor()

def dec(b):
    if isinstance(b, bytes):
        return b.decode('utf-8', 'replace')
    return b

tables = [dec(r[0]) for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
print('TABLES:', json.dumps(tables, ensure_ascii=False))

# find candidate tables for agent instances
cand = [t for t in tables if any(k in t.lower() for k in ('agent', 'instance', 'provider', 'model'))]
print('CANDIDATE TABLES:', cand)

for t in cand:
    try:
        cols = [dec(r[1]) for r in cur.execute(f'PRAGMA table_info("{t}")')]
        print(f'--- {t} cols: {cols}')
        rows = cur.execute(f'SELECT * FROM "{t}" LIMIT 200').fetchall()
        for row in rows:
            d = {c: dec(v) for c, v in zip(cols, row)}
            s = json.dumps(d, ensure_ascii=False)
            if 'opencode' in s or 'codex' in s.lower() or 'deepseek' in s.lower():
                # mask secrets
                for k in list(d):
                    if d[k] and isinstance(d[k], str) and any(x in k.lower() for x in ('key','token','secret')):
                        d[k] = d[k][:6] + '***'
                print(f'ROW in {t}:', json.dumps(d, ensure_ascii=False)[:2000])
    except Exception as e:
        print(f'ERR {t}: {e}')
