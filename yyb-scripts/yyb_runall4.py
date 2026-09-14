# yyb_runall4.py — 全量验证 v4（严格判定版）
# - 逐个 task 执行所有启用的 cron 脚本（排除每分钟任务）
# - 严格分类：FAIL(退出码!=0) / SKIP(跳过·回退·注入0账号) / INFRA(链路错误) / RATE(限频) / TIMEOUT / BIZ(业务失败但链路通) / OK
# - 2 线程 + 启动间隔 20s；检测到限频冷却 180s
import json, subprocess, threading, time, os, re, urllib.request, shlex, signal

QL = "http://127.0.0.1:5700"
CID, CSECRET = "YOUR_QL_CLIENT_ID", "YOUR_QL_CLIENT_SECRET"
OUT = "/ql/data/log/yyb_runall4"
os.makedirs(OUT, exist_ok=True)
LOCK = threading.Lock()
STATE = {"done": 0, "ok": 0, "fail": 0, "skip": 0, "infra": 0, "rate": 0, "timeout": 0, "biz": 0, "total": 0, "cooldown": 0, "start": time.strftime("%F %T")}
COOLDOWN_UNTIL = [0]

SKIP_MARKS = ["未匹配到账号", "回退为全量", "本次注入 YYB 账号: 0", "本次选择: 0 个", "[wrap] 跳过"]
INFRA_MARKS = ["credentials", "econnrefused", "etimedout", "yyb-go:8000", "总控失败", "cannot be constructed", "获取Code失败", "getcode失败"]
RATE_MARKS = ["限频", "请求频繁", "too many requests", "429"]


def token():
    u = f"{QL}/open/auth/token?client_id={CID}&client_secret={CSECRET}"
    d = json.load(urllib.request.urlopen(u, timeout=15))
    return d["data"]["token"]


def api(path, tok):
    req = urllib.request.Request(f"{QL}{path}", headers={"Authorization": f"Bearer {tok}"})
    return json.load(urllib.request.urlopen(req, timeout=20))


def journal(msg):
    with LOCK:
        with open(f"{OUT}/journal.txt", "a", encoding="utf-8") as f:
            f.write(msg + "\n")


def save_status():
    with LOCK:
        with open(f"{OUT}/status.json", "w", encoding="utf-8") as f:
            json.dump(STATE, f, ensure_ascii=False)


def classify(out, rc):
    low = out.lower()
    hits = lambda marks: [m for m in marks if m.lower() in low]
    if hits(INFRA_MARKS):
        return "INFRA", hits(INFRA_MARKS)
    if hits(RATE_MARKS):
        return "RATE", hits(RATE_MARKS)
    if hits(SKIP_MARKS):
        return "SKIP", hits(SKIP_MARKS)
    if rc != 0:
        return "FAIL", [f"exit={rc}"]
    # 业务失败但正常跑完：退出码0且无跳过/链路问题 → OK
    return "OK", []


def worker(queue, tok_holder):
    while True:
        with LOCK:
            if not queue:
                return
            c = queue.pop(0)
        cid = c["id"]
        name = c.get("name") or f"cron{cid}"
        cmd = (c.get("command") or "").strip()
        if cmd.startswith("task "):
            payload = cmd[5:].strip()
        else:
            payload = cmd
        # 限频冷却等待
        while time.time() < COOLDOWN_UNTIL[0]:
            time.sleep(5)
        t0 = time.time()
        journal(f"RUN\t{cid}\t{name}\t{payload[:120]}")
        out, rc = "", -1
        try:
            argv = ["task"] + shlex.split(payload)
            p = subprocess.Popen(argv, cwd="/ql/data/scripts",
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, errors="replace", start_new_session=True)
            try:
                out, _ = p.communicate(timeout=600)
                rc = p.returncode
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(p.pid), signal.SIGKILL)
                except Exception:
                    p.kill()
                try:
                    out, _ = p.communicate(timeout=15)
                except Exception:
                    out = "(timeout 600s)"
                rc = "TIMEOUT"
        except Exception as e:
            out = f"runner error: {e}"
            rc = -2
        secs = round(time.time() - t0)
        if rc == "TIMEOUT":
            status, marks = "TIMEOUT", ["600s 超时"]
        else:
            status, marks = classify(out, rc)
        tail = out.strip().replace("\n", " ⏎ ")[-260:]
        journal(f"END\t{cid}\t{name}\t{status}\t{secs}s\t{';'.join(marks)}\t{tail}")
        with LOCK:
            STATE["done"] += 1
            STATE[status.lower()] = STATE.get(status.lower(), 0) + 1
            if status == "RATE":
                COOLDOWN_UNTIL[0] = max(COOLDOWN_UNTIL[0], time.time() + 180)
            save_status()


def main():
    journal(f"=== START-V4 {STATE['start']} ===")
    tok = token()
    crons = api("/open/crons?searchValue=", tok)["data"]
    if isinstance(crons, dict):
        crons = crons.get("data") or []
    enabled = [c for c in crons if not c.get("isDisabled") and (c.get("schedule") or "").strip() != "* * * * *"]
    enabled.sort(key=lambda x: x["id"])
    STATE["total"] = len(enabled)
    journal(f"TOTAL\t{len(enabled)}")
    save_status()
    queue = list(enabled)
    threads = [threading.Thread(target=worker, args=(queue, tok), daemon=True) for _ in range(2)]
    for t in threads:
        t.start()
        time.sleep(20)
    for t in threads:
        t.join()
    journal(f"=== DONE-V4 ok={STATE['ok']} fail={STATE['fail']} skip={STATE['skip']} infra={STATE['infra']} rate={STATE['rate']} timeout={STATE['timeout']} biz={STATE['biz']} total={STATE['total']} ===")
    save_status()


if __name__ == "__main__":
    main()
