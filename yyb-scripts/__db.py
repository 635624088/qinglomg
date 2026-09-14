# -*- coding: utf-8 -*-
import sqlite3

c = sqlite3.connect("/ql/data/db/database.sqlite", timeout=30)
c.row_factory = sqlite3.Row
print("=== Envs FRW* / PUSHPLUS ===")
for r in c.execute("select id,name,value from Envs where name like 'FRW%' or name='PUSHPLUS_TOKEN'"):
    d = dict(r)
    v = d.get("value") or ""
    print(d["id"], d["name"], "len=%d" % len(v), repr(v[:200]))

print()
print("=== Crontabs id=250 ===")
for r in c.execute("select id,name,command,schedule,status from Crontabs where id=250"):
    print(dict(r))
