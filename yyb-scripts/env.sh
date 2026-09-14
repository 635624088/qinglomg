#!/bin/bash
# ============================================================
# env.sh — 手动调试时加载青龙全部环境变量
# 由 WorkBuddy 编写（2026-08-17）
#
# 用法：
#   docker exec qinglong bash -c 'source /ql/data/scripts/env.sh && node xxx.js'
#   docker exec qinglong bash -c 'source /ql/data/scripts/env.sh && python3 xxx.py'
#
# 作用：从青龙 API 拉取面板全部环境变量并 export 到当前 shell，
#       效果等同 task 注入。适用于调试需要直接 node/python 的场景；
#       日常手动运行请优先用 run.sh（更接近面板行为）。
# ============================================================
TOKEN=$(curl -s -X POST http://127.0.0.1:5700/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"YOUR_PHONE","password":"YOUR_QL_PASSWORD"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "[env.sh] ❌ 青龙登录失败，环境变量未加载" >&2
  return 1 2>/dev/null || exit 1
fi

eval "$(curl -s http://127.0.0.1:5700/api/envs -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin).get('data', [])
except Exception:
    data = []
for e in data:
    name = e.get('name', '')
    if not name:
        continue
    val = str(e.get('value', ''))
    esc = val.replace(\"'\", \"'\\\\''\")
    print('export %s=\x27%s\x27' % (name, esc))
")"

echo "[env.sh] ✅ 已加载 $(env | grep -cE '^(GH_WX_BASE|YYB|WECHAT|MLLS)') 个关键环境变量"
