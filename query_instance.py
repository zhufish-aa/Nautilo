# -*- coding: utf-8 -*-
import sqlite3, json
con = sqlite3.connect('file:C:/Users/admin/AppData/Roaming/@agenthub/desktop/agenthub.sqlite?mode=ro', uri=True)
row = con.execute("SELECT data FROM agents WHERE id='agent_74035a34'").fetchone()
d = json.loads(row[0])
models = d.pop('models', [])
print(json.dumps(d, ensure_ascii=False, indent=1))
print('MODEL COUNT:', len(models))
for m in models:
    if 'deepseek' in m.get('id', ''):
        print('DEEPSEEK MODEL ENTRY:', json.dumps(m, ensure_ascii=False))
