#!/usr/bin/env python3
# Wrapper that replicates run_junpinhui.sh logic but as a .py so the
# YYB Go platform (which only ingests .py/.js crons) can list it.
import os, sys
os.environ['YYB_URL'] = 'http://172.17.0.1:18080'
os.environ['YYB_USER'] = 'yyb'
os.environ['YYB_PASS'] = 'yyb'
os.environ['YYB_AUTO_ACCOUNTS'] = '1'
os.environ['PYTHONUNBUFFERED'] = '1'
REAL = '/ql/data/scripts/君品荟/君品荟.py'
os.execv(sys.executable, [sys.executable, REAL] + sys.argv[1:])
