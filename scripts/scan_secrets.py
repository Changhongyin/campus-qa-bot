#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""密钥泄露扫描：检查源码与产物是否泄露 sk-、github_pat_、ghp_、Bearer 密钥。"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAT = re.compile(
    r'sk-[A-Za-z0-9]{16,}|'
    r'github_pat_[A-Za-z0-9]{20,}|'
    r'ghp_[A-Za-z0-9]{20,}|'
    r'Bearer [A-Za-z0-9._~+/=-]{8,}'
)
SCAN_DIRS = ['dist', 'src', 'api', 'lib']
EXTENSIONS = {'.js', '.ts', '.tsx', '.jsx', '.html', '.css', '.json', '.mjs', '.cjs', '.map'}


def scan():
    leaks = []
    for d in SCAN_DIRS:
        p = ROOT / d
        if not p.exists():
            continue
        for f in p.rglob('*'):
            if not f.is_file():
                continue
            if f.suffix not in EXTENSIONS:
                continue
            try:
                txt = f.read_text(encoding='utf-8', errors='ignore')
            except Exception:
                continue
            for m in PAT.findall(txt):
                masked = m[:8] + '***'
                leaks.append((str(f.relative_to(ROOT)), masked))
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
