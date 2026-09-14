# -*- coding: utf-8 -*-
"""安全查两个可用号的挑战额度(不答题, 零消耗)"""
import sys
sys.path.insert(0, "/ql/data/scripts")
import junpinhui_dati_yyb as J

for ref in ["999128", "999134"]:
    try:
        code = J.yyb_get_code(ref)
        token = J.silent_login(code)
        api = J.Api(token)
        ml = api.member_login()
        home = api.challenge_home()
        d = (home.get("data") or {})
        print(f"[ref={ref}] login={'OK' if token else 'FAIL'} "
              f"可挑战={d.get('canChallenge')} 已用={d.get('usedCount')}/{d.get('totalCount')} "
              f"分享复活剩={d.get('reviveLeft')} phone={(d.get('phone') or '?')}", flush=True)
    except Exception as e:
        print(f"[ref={ref}] EXC: {e}", flush=True)
print("STATUS_DONE", flush=True)
