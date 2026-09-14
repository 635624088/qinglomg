# -*- coding: utf-8 -*-
"""Re-run timed-out scripts with a 1800s cap, sequentially.
Journal: /ql/data/log/yyb_runall/rerun.txt
"""
import json
import os
import signal
import subprocess
import time

TIMEOUT = 1800
STDIR = "/ql/data/log/yyb_runall"

SCRIPTS = [
    "/ql/data/scripts/gh_deploy/yyb_collection/yyb/同程里程_自动登录.js",
    "/ql/data/scripts/gh_deploy/yyb_collection/yyb/宝妈上班.py",
    "/ql/data/scripts/gh_deploy/yyb_collection/yyb/小天鹅_签到_YYB.js",
    "/ql/data/scripts/gh_deploy/yyb_collection/yyb/电玩.js",
    "/ql/data/scripts/gh_deploy/yyb_collection/yyb/话费一元起充.py",
    "/ql/data/scripts/gh_deploy/yyb_collection/yyb/飞鹤北纬47度签到.py",
    "/ql/data/scripts/gh_deploy/yyb_collection/yyb/骁龙小程序.py",
    "/ql/data/scripts/gh_deploy/yyb_wrap/hhl1916_tasks.py",
    "/ql/data/scripts/gh_deploy/yyb_wrap/junpinhui_dati_yyb.py",
]


def run(path):
    p = subprocess.Popen(["task", path], cwd="/ql/data/scripts",
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         start_new_session=True)
    try:
        out, _ = p.communicate(timeout=TIMEOUT)
        return p.returncode, out.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:
            pass
        return -8, "TIMEOUT after 1800s"


def oneline(txt, n=280):
    lines = [ln.rstrip() for ln in txt.splitlines() if ln.strip()]
    return (" | ".join(lines))[-n:]


for path in SCRIPTS:
    name = os.path.basename(path)
    code, out = run(path)
    with open(STDIR + "/rerun.txt", "a", encoding="utf-8") as f:
        f.write(f"{name}\texit={code}\t{oneline(out)}\n")

with open(STDIR + "/rerun.txt", "a", encoding="utf-8") as f:
    f.write("=== RERUN DONE ===\n")
