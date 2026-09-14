#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ============================================================
# sync_yyb_go.py — 自动同步 YYB 服务账号 → 青龙 YYB_GO 环境变量
# 由 WorkBuddy 编写（2026-08-17）。纯标准库，零依赖。
# 2026-08-20 v2：识别掉线账号。
#   /accounts 的 status 字段：alive=在线，expired/其他=掉线。
#   - 只把 alive 账号同步进 YYB_GO（新号自动追加）
#   - YYB 里掉线的账号自动从 YYB_GO 移除（重新扫码恢复在线后，
#     下次同步会自动加回，openid 不变）
#   - 不在 YYB 里的手动行保留不动
#   - 每次运行都输出：总数/在线/掉线 + 掉线名单
# 运行方式：青龙 task（每小时整点，ID=159）
# ============================================================
import json
import os
import urllib.request

QL_API = "http://127.0.0.1:5700"
QL_USER = "YOUR_PHONE"
QL_PASS = "YOUR_QL_PASSWORD"
YYB_BASE = (os.environ.get("YYB_BASE_URL") or "http://172.17.0.1:18080").rstrip("/")


def http(method, url, data=None, token=None, timeout=20):
    req = urllib.request.Request(url, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    body = json.dumps(data).encode() if data is not None else None
    try:
        with urllib.request.urlopen(req, data=body, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", errors="ignore"))
    except Exception as e:
        return {"_error": str(e)}


# ---- 2026-09-02 v3: 账号优先级排序 ----
# 读取 YYB_PRIORITY（我的账号 openid，换行分隔），重排 YYB_GO：
# 我的账号永远排最前，其他人排后面。这样所有按 YYB_GO 顺序执行的脚本
# 都会先跑我的账号。
def get_priority_refs():
    raw = os.environ.get("YYB_PRIORITY") or ""
    refs = [x.strip() for x in raw.replace(",", "\n").split("\n") if x.strip()]
    return refs


def reorder_priority(lines, priority):
    """把 priority 里的 openid 对应行移到最前(按 priority 顺序)，其余保持原相对顺序。"""
    if not priority:
        return lines
    pri_set = set(priority)
    first = []
    rest = []
    # 先按 priority 顺序收集存在的行
    tmp = {}
    for l in lines:
        oid = l.split("@")[1].strip() if "@" in l else ""
        if oid:
            tmp.setdefault(oid, l)
    for p in priority:
        if p in tmp:
            first.append(tmp[p])
    # 其余非优先级行(含无@行)保持原顺序
    for l in lines:
        oid = l.split("@")[1].strip() if "@" in l else ""
        if not (oid and oid in pri_set):
            rest.append(l)
    return first + rest


def main():
    # 1. YYB 账号列表（含 status）
    d = http("GET", YYB_BASE + "/accounts")
    accounts = d.get("data") or []
    if not isinstance(accounts, list) or not accounts:
        print("[sync] ❌ /accounts 返回异常:", json.dumps(d, ensure_ascii=False)[:200])
        return 1

    names, alive, offline = {}, [], []
    for a in accounts:
        oid = (a.get("openid") or a.get("wxid") or "").strip()
        if not oid:
            continue
        names[oid] = (a.get("nickname") or a.get("alias") or a.get("remark") or oid).strip()
        if (a.get("status") or "").strip().lower() == "alive":
            alive.append(oid)
        else:
            offline.append(oid)

    # 2. 状态总览（每次都输出，掉线一眼可见）
    print(f"[sync] YYB 账号 {len(accounts)} 个：在线 {len(alive)}，掉线 {len(offline)}")
    for oid in offline:
        print(f"  ⚠️ 掉线：{names[oid]}（status=expired，已/将移出 YYB_GO，需重新扫码）")

    # 3. 现有 YYB_GO（task 已注入当前值）
    cur = [l.strip() for l in (os.environ.get("YYB_GO") or "").split("\n") if l.strip()]
    addr = cur[0].split("@")[0].strip() if cur else "172.17.0.1:18080"
    alive_set, offline_set = set(alive), set(offline)

    # 4. 重组：掉线行移除；已从 YYB 删除的行移除；真正的手动行保留；alive 新号追加
    new_lines, removed, deleted = [], [], []
    pool_set = set(names.keys())
    for l in cur:
        oid = l.split("@")[1].strip() if "@" in l else ""
        if oid and oid in offline_set:
            removed.append(oid)
            continue
        if oid and oid not in pool_set:
            # 不在 /accounts 里 = 账号已从 YYB 删除，清掉残留引用
            deleted.append(oid)
            continue
        new_lines.append(l)
    if deleted:
        print(f"[sync] 🧹 清理已删除账号残留引用 {len(deleted)} 个")
    exist = {l.split("@")[1].strip() for l in new_lines if "@" in l}
    added = [oid for oid in alive if oid not in exist]
    for oid in added:
        new_lines.append(addr + "@" + oid)

    # 4.5 优先级重排: 我的账号排最前 (YYB_PRIORITY)
    priority = get_priority_refs()
    reordered = reorder_priority(new_lines, priority)
    order_changed = reordered != new_lines
    new_lines = reordered

    if not added and not removed and not deleted and not order_changed:
        print(f"[sync] 无变化：YYB_GO 保持 {len(new_lines)} 行（全部在线）")
        return 0

    # 5. 登录青龙并写回
    login = http("POST", QL_API + "/api/user/login", {"username": QL_USER, "password": QL_PASS})
    token = (login.get("data") or {}).get("token")
    if not token:
        print("[sync] ❌ 青龙登录失败:", json.dumps(login, ensure_ascii=False)[:200])
        return 1

    envs = http("GET", QL_API + "/api/envs", token=token)
    yybg = next((e for e in (envs.get("data") or []) if e.get("name") == "YYB_GO"), None)
    if not yybg:
        print("[sync] ❌ 青龙里找不到 YYB_GO 环境变量")
        return 1

    upd = http("PUT", QL_API + "/api/envs",
               {"id": yybg["id"], "name": "YYB_GO",
                "value": "\n".join(new_lines), "remarks": yybg.get("remarks") or ""},
               token=token)
    if upd.get("code") != 200:
        print("[sync] ❌ 更新 YYB_GO 失败:", json.dumps(upd, ensure_ascii=False)[:200])
        return 1

    if added:
        print(f"[sync] ➕ 新增 {len(added)} 个在线账号：")
        for oid in added:
            print(f"  + {names[oid]} ({oid})")
    if removed:
        print(f"[sync] ➖ 移除 {len(removed)} 个掉线账号：")
        for oid in removed:
            print(f"  - {names[oid]} ({oid})")
    print(f"[sync] ✅ YYB_GO 现在 {len(new_lines)} 行（YYB 在线 {len(alive)}/共 {len(accounts)}）")
    if priority:
        pl = [names.get(p, p) for p in priority]
        print(f"[sync] 🔀 优先顺序: {' → '.join(pl)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
