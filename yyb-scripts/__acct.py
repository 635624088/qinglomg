# -*- coding: utf-8 -*-
import json
import urllib.request

base = "http://172.17.0.1:18082"
body = json.dumps({"username": "admin", "password": "YOUR_QL_PASSWORD"}).encode()
req = urllib.request.Request(base + "/login", data=body,
                             headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(req, timeout=12) as r:
    cookie = r.headers.get("Set-Cookie", "").split(";")[0]

req = urllib.request.Request(base + "/accounts", headers={"Cookie": cookie})
with urllib.request.urlopen(req, timeout=12) as r:
    b = r.read().decode("utf-8", "replace")
js = json.loads(b)
print("top keys:", list(js.keys()))
arr = js.get("data")
if isinstance(arr, dict):
    print("data keys:", list(arr.keys()))
    for k, v in arr.items():
        if isinstance(v, list):
            arr = v
            print("list under data.%s len=%d" % (k, len(v)))
            break
print("type:", type(arr), "len:", len(arr) if hasattr(arr, "__len__") else "-")
if isinstance(arr, list) and arr:
    print("--- first account RAW ---")
    print(json.dumps(arr[0], ensure_ascii=False, indent=2)[:1500])
