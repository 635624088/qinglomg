# -*- coding: utf-8 -*-
"""Run-all controller v3: 2 workers, min 25s between task starts,
direct subprocess execution inside qinglong container.

Status:  /ql/data/log/yyb_runall/status.json
Journal: /ql/data/log/yyb_runall/journal.txt
"""
import json
import os
import signal
import subprocess
import threading
import time
import urllib.request

QL = "http://127.0.0.1:5700"
CID = "YOUR_QL_CLIENT_ID"
CSEC = "YOUR_QL_CLIENT_SECRET"
STDIR = "/ql/data/log/yyb_runall"
os.makedirs(STDIR, exist_ok=True)

SKIP_IDS = {159, 247, 226, 233, 234}
SKIP_NAME = ("同步YYB账号", "君品汇奖池查询", "清理习酒token缓存",
             "WPS获取奖品信息", "小天鹅_蛋壳兑换")
TIMEOUT = 600
WORKERS = 2
MIN_START_GAP = 25

RATE_WORDS = ("限频", "频繁", "too many", "rate limit")
INFRA_KW = ("credentials", "yyb-go", "getcode", "/accounts", "econnrefused",
            "enotfound", "etimedout", "basic auth", "cannot be constructed",
            "总控失败")

TOKEN = [None]
LOCK = threading.Lock()
STATE = {"last_start": 0.0, "rate_cnt": 0, "cooldown": 0}


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(QL + path, data=data, method=method)
    if data:
        r.add_header("Content-Type", "application/json")
    if TOKEN[0]:
        r.add_header("Authorization", "Bearer " + TOKEN[0])
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode())


def save_status(st):
    tmp = STDIR + "/status.json.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STDIR + "/status.json")


def journal(line):
    with LOCK:
        with open(STDIR + "/journal.txt", "a", encoding="utf-8") as f:
            f.write(line + "\n")


def run_task(cmd_str):
    args = cmd_str.split()
    if not (args and args[0] == "task"):
        args = ["task"] + args
    p = subprocess.Popen(args, cwd="/ql/data/scripts",
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         start_new_session=True)
    try:
        out, _ = p.communicate(timeout=TIMEOUT)
        return p.returncode, out.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
        return -8, "TIMEOUT after %ss" % TIMEOUT


def classify(code, tail):
    if code == 0:
        return "OK"
    if code == -8:
        return "TIMEOUT"
    low = tail.lower()
    if any(k in low for k in INFRA_KW):
        return "INFRA?"
    if any(k in tail for k in RATE_WORDS):
        return "RATE?"
    return "BIZ"


def oneline(txt, n=280):
    lines = [ln.rstrip() for ln in txt.splitlines() if ln.strip()]
    return (" | ".join(lines))[-n:]


def worker(queue, st):
    while True:
        with LOCK:
            if not queue:
                return
            c = queue.pop(0)
        while STATE["cooldown"] > 0:
            time.sleep(2)
        # pacing between task starts
        with LOCK:
            wait = max(0.0, MIN_START_GAP - (time.time() - STATE["last_start"]))
        if wait > 0:
            time.sleep(wait)
        with LOCK:
            STATE["last_start"] = time.time()
        cid = c["id"]
        name = c.get("name") or f"cron{cid}"
        cmd = (c.get("command") or "").strip()
        if not cmd:
            continue
        with LOCK:
            st["running"] = name
        code, out = run_task(cmd)
        cls = classify(code, out)
        journal(f"{name}\texit={code}\t{cls}\t{oneline(out)}")
        cool = 0
        with LOCK:
            st["done"] += 1
            st["running"] = None
            if cls == "OK":
                st["ok"] += 1
                STATE["rate_cnt"] = 0
            else:
                st["fail"] += 1
                if cls == "RATE?":
                    STATE["rate_cnt"] += 1
                else:
                    STATE["rate_cnt"] = 0
            if STATE["rate_cnt"] >= 2:
                journal(">>> rate suspected, cooling 180s")
                STATE["rate_cnt"] = 0
                cool = 1
        if cool:
            STATE["cooldown"] = 1
            time.sleep(180)
            STATE["cooldown"] = 0
        time.sleep(3)


def main():
    t = req("GET", f"/open/auth/token?client_id={CID}&client_secret={CSEC}")
    TOKEN[0] = t["data"]["token"]
    r = req("GET", "/open/crons?searchValue=&t=0")
    crons = r["data"] if isinstance(r["data"], list) else r["data"].get("data", [])
    targets = []
    for c in crons:
        if c.get("isDisabled"):
            continue
        if c["id"] in SKIP_IDS or any(k in c.get("name", "") for k in SKIP_NAME):
            continue
        targets.append(c)
    targets.sort(key=lambda x: x["id"])

    st = {"total": len(targets), "done": 0, "ok": 0, "fail": 0,
          "started": time.time(), "running": None}
    save_status(st)
    journal(f"=== START-V3 {time.strftime('%F %T')} targets={len(targets)} ===")

    q = list(targets)
    threads = [threading.Thread(target=worker, args=(q, st), daemon=True)
               for _ in range(WORKERS)]
    for th in threads:
        th.start()
        time.sleep(5)
    for th in threads:
        th.join()

    st["finished"] = time.time()
    st["running"] = "DONE"
    save_status(st)
    journal(f"=== DONE {time.strftime('%F %T')} ok={st['ok']} fail={st['fail']} ===")


if __name__ == "__main__":
    main()
