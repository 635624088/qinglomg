# yyb_runall5.py — 全量验证 v5（防呆版）
# 用法: python3 yyb_runall5.py even|odd
# - 两个独立进程各跑一半任务，无锁无线程
# - 任务输出直接写文件（不用管道，杜绝子孙进程握管道导致的挂死）
# - 超时 600s：killpg 整组击杀后 wait 收尸
import json, subprocess, threading, time, os, sys, shlex, signal, urllib.request

QL = "http://127.0.0.1:5700"
CID, CSECRET = "YOUR_QL_CLIENT_ID", "YOUR_QL_CLIENT_SECRET"
SLICE = sys.argv[1] if len(sys.argv) > 1 else "even"
OUT = f"/ql/data/log/yyb_runall5/{SLICE}"
os.makedirs(OUT, exist_ok=True)
JOURNAL = f"{OUT}/journal.txt"

SKIP_MARKS = ["未匹配到账号", "回退为全量", "本次注入 YYB 账号: 0", "本次选择: 0 个", "[wrap] 跳过"]
INFRA_MARKS = ["credentials", "econnrefused", "etimedout", "yyb-go:8000", "总控失败", "cannot be constructed", "获取Code失败"]
RATE_MARKS = ["限频", "请求频繁", "too many requests", "429"]
COOLDOWN = [0]


def token():
    u = f"{QL}/open/auth/token?client_id={CID}&client_secret={CSECRET}"
    return json.load(urllib.request.urlopen(u, timeout=15))["data"]["token"]


def api(path, tok):
    req = urllib.request.Request(f"{QL}{path}", headers={"Authorization": f"Bearer {tok}"})
    return json.load(urllib.request.urlopen(req, timeout=20))


def journal(msg):
    with open(JOURNAL, "a", encoding="utf-8") as f:
        f.write(msg + "\n")


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
    return "OK", []


def run_one(cid, name, payload, idx):
    while time.time() < COOLDOWN[0]:
        time.sleep(5)
    t0 = time.time()
    outfile = f"{OUT}/t_{idx}.out"
    journal(f"RUN\t{cid}\t{name}\t{payload[:120]}")
    argv = ["task"] + shlex.split(payload)
    rc, out = -1, ""
    try:
        with open(outfile, "w", encoding="utf-8", errors="replace") as fo:
            p = subprocess.Popen(argv, cwd="/ql/data/scripts", stdout=fo,
                                 stderr=subprocess.STDOUT, start_new_session=True)
            try:
                p.wait(timeout=600)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(p.pid), signal.SIGKILL)
                except Exception:
                    pass
                try:
                    p.wait(timeout=10)
                except Exception:
                    p.kill()
                rc = "TIMEOUT"
            else:
                rc = p.returncode
    except Exception as e:
        out = f"runner error: {e}"
        rc = -2
    secs = round(time.time() - t0)
    if rc != "TIMEOUT" and not out:
        try:
            with open(outfile, "r", encoding="utf-8", errors="replace") as f:
                out = f.read()
        except Exception:
            out = ""
    try:
        os.remove(outfile)
    except Exception:
        pass
    if rc == "TIMEOUT":
        status, marks = "TIMEOUT", ["600s超时"]
    else:
        status, marks = classify(out, rc)
    tail = out.strip().replace("\n", " ⏎ ")[-260:]
    journal(f"END\t{cid}\t{name}\t{status}\t{secs}s\t{';'.join(marks)}\t{tail}")
    if status == "RATE":
        COOLDOWN[0] = max(COOLDOWN[0], time.time() + 180)


def main():
    tok = token()
    crons = api("/open/crons?searchValue=", tok)["data"]
    if isinstance(crons, dict):
        crons = crons.get("data") or []
    enabled = [c for c in crons if not c.get("isDisabled") and (c.get("schedule") or "").strip() != "* * * * *"]
    enabled.sort(key=lambda x: x["id"])
    mine = [c for i, c in enumerate(enabled) if (i % 2 == 0) == (SLICE == "even")]
    journal(f"=== START-V5 {time.strftime('%F %T')} slice={SLICE} n={len(mine)} ===")
    for i, c in enumerate(mine):
        cmd = (c.get("command") or "").strip()
        payload = cmd[5:].strip() if cmd.startswith("task ") else cmd
        try:
            run_one(c["id"], c.get("name") or f"cron{c['id']}", payload, i)
        except Exception as e:
            journal(f"END\t{c['id']}\t{c.get('name')}\tFAIL\t0s\tcontroller\t{e}")
    journal(f"=== DONE-V5 {time.strftime('%F %T')} slice={SLICE} ===")


if __name__ == "__main__":
    main()
