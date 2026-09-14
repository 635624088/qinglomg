#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""青龙任务结果推送 pushplus —— 由 task_after.sh 钩子在每个任务结束后调用。

读取环境变量:
  QL_TASK_EXIT_CODE  任务退出码(0=成功, 非0=失败)
  QL_TASK_ARGS       任务参数(含脚本路径, 用于解析任务名)
  QL_TASK_ID         cron id(如有)
逻辑: 解析任务名 -> 在 /ql/data/log 下找最近结束任务的日志(优先匹配任务名)取尾部摘要 -> 推送到 pushplus
"""
import json
import os
import sys
import time
import urllib.request

PUSH_TOKEN = os.environ.get("PUSH_PLUS_TOKEN") or "67aad81a53fc44c4a822760023ff1501"
LOG_BASE = "/ql/data/log"
PUSH_URL = "https://www.pushplus.plus/send"
MAX_AGE = 180  # 日志必须是 180 秒内的（任务刚结束）


def log(*a):
    sys.stderr.write(" ".join(str(x) for x in a) + "\n")


def tail_lines(path, n=15):
    try:
        with open(path, "rb") as f:
            data = f.read().decode("utf-8", "replace")
    except Exception as e:
        return ["(读取日志失败: %s)" % e]
    lines = [ln.rstrip() for ln in data.splitlines() if ln.strip()]
    return lines[-n:]


def find_recent_log(task_name, max_age=MAX_AGE):
    """找最近结束任务的日志文件: 180 秒内修改的 .log, 优先匹配任务名。"""
    base = task_name.rsplit(".", 1)[0] if "." in task_name else task_name
    candidates = []
    try:
        for root, _dirs, files in os.walk(LOG_BASE):
            for fn in files:
                if not fn.endswith(".log"):
                    continue
                p = os.path.join(root, fn)
                try:
                    mt = os.path.getmtime(p)
                except OSError:
                    continue
                if time.time() - mt <= max_age:
                    candidates.append((mt, p, root, fn))
    except Exception as e:
        log("walk log dir failed:", e)
        return None
    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0], reverse=True)
    for _mt, p, root, fn in candidates:
        if base and (base in root or base in fn):
            return p
    return candidates[0][1]  # 回退: 最新修改的


def push(title, content):
    body = json.dumps({
        "token": PUSH_TOKEN,
        "title": title,
        "content": content,
        "template": "html",
    }).encode("utf-8")
    req = urllib.request.Request(
        PUSH_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        resp = json.loads(r.read().decode("utf-8", "replace"))
        if resp.get("code") != 200:
            log("pushplus failed:", resp)
            return False
        return True


def main():
    code = os.environ.get("QL_TASK_EXIT_CODE", "")
    if code == "":
        return  # 非任务结束场景, 不推送
    args = os.environ.get("QL_TASK_ARGS", "")
    task_id = os.environ.get("QL_TASK_ID", "")

    # 解析任务名: 取参数中的脚本文件名
    task_name = "未知任务"
    for part in args.split():
        if part.endswith((".py", ".js", ".mjs", ".ts", ".pyc", ".sh")):
            task_name = part.replace("\\", "/").split("/")[-1]
            break
    if "ql_result_push" in task_name:
        return  # 自身不推送

    ok = (code == "0")
    status = "✅ 成功" if ok else "❌ 失败"
    title = "青龙任务 %s: %s" % (status, task_name)

    log_path = find_recent_log(task_name)
    if log_path:
        lines = tail_lines(log_path)
        summary = "<br>".join(lines)[:1800]
    else:
        summary = "(未找到任务日志)"

    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    content = (
        "任务: %s<br>状态: %s (退出码 %s)<br>时间: %s"
        % (task_name, status, code, ts)
        + ("<br>CronID: %s" % task_id if task_id else "")
        + ("<br>日志文件: %s" % log_path if log_path else "")
        + "<br>--- 日志摘要 ---<br>" + summary
    )
    try:
        push(title, content)
        log("pushed:", title)
    except Exception as e:
        log("push error:", e)


if __name__ == "__main__":
    main()
