import json, subprocess, threading, time, os, urllib.request, shlex

BASE = "http://127.0.0.1:5700"
tok = json.load(urllib.request.urlopen(BASE + "/open/auth/token?client_id=YOUR_QL_CLIENT_ID&client_secret=YOUR_QL_CLIENT_SECRET"))["data"]["token"]

def api(path, method="GET", body=None):
    req = urllib.request.Request(BASE + path, method=method,
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body else None)
    return json.load(urllib.request.urlopen(req))

d = api("/open/crons?searchValue=")
data = d["data"]
items = data if isinstance(data, list) else data.get("data", [])
CMD = {c["id"]: c["command"] for c in items}

CIDS = [23, 37, 53, 59, 78, 80, 97, 118, 124, 146, 152, 22, 44, 54, 61, 63, 65, 90, 111, 119, 125, 145, 153, 155, 161, 204, 220, 233]

OUT = "/ql/data/log/yyb_rerun2"
os.makedirs(OUT, exist_ok=True)
jpath = os.path.join(OUT, "journal.txt")

def worker(chunk, tag):
    for cid in chunk:
        cmd = CMD.get(cid, "")
        if not cmd:
            continue
        name = cmd.split()[-1]
        with open(jpath, "a", encoding="utf-8") as f:
            f.write(f"RUN\t{cid}\t{name}\t{time.strftime('%H:%M:%S')}\n")
        out_file = os.path.join(OUT, f"out_{cid}.txt")
        argv = ["task"] + shlex.split(cmd.replace("task ", "", 1)) if cmd.startswith("task ") else ["task", name]
        rc = None
        try:
            with open(out_file, "w", encoding="utf-8") as fo:
                p = subprocess.Popen(argv, cwd="/ql/data/scripts", stdout=fo, stderr=subprocess.STDOUT,
                                     start_new_session=True)
                try:
                    rc = p.wait(timeout=1800)
                except subprocess.TimeoutExpired:
                    os.killpg(os.getpgid(p.pid), 9)
                    p.wait()
                    rc = "TIMEOUT"
        except Exception as e:
            rc = f"ERR:{e}"
        with open(jpath, "a", encoding="utf-8") as f:
            f.write(f"END\t{cid}\t{name}\t{rc}\t{time.strftime('%H:%M:%S')}\n")
    with open(jpath, "a", encoding="utf-8", errors="ignore") as f:
        f.write(f"=== DONE-rerun2 {time.strftime('%Y-%m-%d %H:%M:%S')} slice={tag}\n")

half = (len(CIDS) + 1) // 2
t1 = threading.Thread(target=worker, args=(CIDS[:half], "a"))
t2 = threading.Thread(target=worker, args=(CIDS[half:], "b"))
t1.start(); t2.start(); t1.join(); t2.join()
