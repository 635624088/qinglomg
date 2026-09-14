# -*- coding: utf-8 -*-
"""把 config.sh 里的 export 改成『已注入则保留，否则用兜底值』"""
import re
import shutil
import sqlite3

CFG = "/ql/data/config/config.sh"
shutil.copy(CFG, CFG + ".bak_20260908b")

# 从数据库取面板里的最新值作为兜底
db = {}
try:
    c = sqlite3.connect("/ql/data/db/database.sqlite", timeout=20)
    for name, val in c.execute(
            "select name,value from Envs where name in "
            "('FRW_TASKS','FRW_CIPHER','FRW_JWT','PUSHPLUS_TOKEN','FRW_ACTIVITY_ID')"):
        db[name] = (val or "")
    c.close()
except Exception as e:
    print("db-err", e)

src = open(CFG, encoding="utf-8", errors="replace").read().splitlines()
out = []
changed = []
for line in src:
    m = re.match(r'^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', line)
    if m and m.group(1) in ("FRW_TASKS", "FRW_CIPHER", "FRW_JWT",
                            "PUSHPLUS_TOKEN", "FRW_ACTIVITY_ID"):
        name = m.group(1)
        old = m.group(2).strip().strip('"').strip("'")
        fallback = db.get(name, old)
        new = 'export %s="${%s:-%s}"' % (name, name, fallback)
        out.append(new)
        changed.append((name, old[:40], fallback[:40]))
    else:
        out.append(line)

open(CFG, "w", encoding="utf-8").write("\n".join(out) + "\n")

print("=== 已修改 ===")
for n, o, f in changed:
    print("  %-16s old=%-42s fallback=%s" % (n, o, f))
print()
print("=== 校验 ===")
for line in open(CFG, encoding="utf-8", errors="replace"):
    if line.startswith("export FRW") or line.startswith("export PUSHPLUS"):
        print("  " + line.rstrip()[:160])
