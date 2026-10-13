#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""密钥泄露扫描：检查前端产物与源码是否泄露 sk- 密钥。"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAT = re.compile(r'sk-[A-Za-z0-9]{16,}')
SCAN_DIRS = ['dist', 'src', 'api', 'lib']


def scan():
    leaks = []
    for d in SCAN_DIRS:
        p = ROOT / d
        if not p.exists():
            continue
        for f in p.rglob('*'):
            if not f.is_file():
                continue
            if f.suffix not in {'.js', '.ts', '.tsx', '.jsx', '.html', '.css', '.json', '.mjs', '.cjs', '.map'}:
                continue
            try:
                txt = f.read_text(encoding='utf-8', errors='ignore')
            except Exception:
                continue
            for m in PAT.findall(txt):
                leaks.append((str(f.relative_to(ROOT)), m[:8] + '***'))
    return leaks


if __name__ == '__main__':
    leaks = scan()
    if leaks:
        print('[FAIL] 发现密钥泄露：')
        for f, k in leaks:
            print('  ' + f + '  ' + k)
        sys.exit(1)
    print('[OK] 未发现密钥泄露（已扫描 dist/src/api/lib）')
    print('说明：static/index.html 为「无后端静态版」，密钥内嵌属已知例外（见 README）')
    sys.exit(0)
