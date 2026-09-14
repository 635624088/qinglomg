# -*- coding: utf-8 -*-
import socket
import json
import urllib.request
import urllib.error

def get(url, hdr=None, timeout=12):
    req = urllib.request.Request(url, headers=hdr or {"User-Agent": "curl/8"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, (e.read()[:200].decode("utf-8", "replace")), dict(e.headers)
    except Exception as e:
        return -1, str(e), {}

print("=== 1) 端口连通性 ===")
for host in ("172.17.0.1", "127.0.0.1"):
    for port in (18082, 18080, 8000):
        s = socket.socket(); s.settimeout(3)
        ok = s.connect_ex((host, port)) == 0
        s.close()
        print(f"  {host}:{port} -> {'OPEN' if ok else 'closed'}")

print()
print("=== 2) YYB 登录 ===")
for base in ("http://172.17.0.1:18082", "http://172.17.0.1:18080"):
    body = json.dumps({"username": "admin", "password": "YOUR_QL_PASSWORD"}).encode()
    req = urllib.request.Request(base + "/login", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            sc = r.headers.get("Set-Cookie", "")
            txt = r.read().decode("utf-8", "replace")[:200]
            print(f"  {base}/login -> {r.status} cookie={'YES' if sc else 'NO'} body={txt}")
            if not sc:
                continue
            cookie = sc.split(";")[0]
            st, b, _ = get(base + "/accounts", {"Cookie": cookie, "User-Agent": "curl/8"})
            print(f"  {base}/accounts -> {st} len={len(b)}")
            if st == 200:
                try:
                    js = json.loads(b)
                    arr = js.get("data") if isinstance(js.get("data"), list) else js
                    if isinstance(arr, list):
                        for a in arr[:15]:
                            print("    ref=%s nick=%s" % (a.get("ref"), a.get("nickName") or a.get("nickname") or a.get("name")))
                except Exception as e:
                    print("    parse-err", e, b[:150])
    except Exception as e:
        print(f"  {base}/login -> ERR {e}")
