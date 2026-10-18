#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2 新增接口测试：/api/upload 与 /api/feedback"""
import json
import os
import sys
import urllib.request
import urllib.error

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
PASS = 0
FAIL = 0


def call(method, path, body=None):
    url = BASE + path
    headers = {"Content-Type": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def check(name, condition):
    global PASS, FAIL
    if condition:
        PASS += 1
        print("  [PASS] " + name)
    else:
        FAIL += 1
        print("  [FAIL] " + name)


def main():
    print("=== v2_test ===")

    status, body = call("POST", "/api/upload", {"fileName": "t.txt", "content": "x"})
    check("上传缺少 consent 返回 422 CONSENT_REQUIRED",
          status == 422 and isinstance(body, dict) and body.get("code") == "CONSENT_REQUIRED")

    status, body = call("POST", "/api/upload",
                        {"fileName": "t.exe", "content": "x", "consent": True})
    check("上传非法扩展名返回 415 UNSUPPORTED_FILE_TYPE",
          status == 415 and isinstance(body, dict) and body.get("code") == "UNSUPPORTED_FILE_TYPE")

    status, body = call("POST", "/api/feedback", {"rating": "meh"})
    check("反馈非法 rating 返回 400 INVALID_PAYLOAD",
          status == 400 and isinstance(body, dict) and body.get("code") == "INVALID_PAYLOAD")

    status, body = call("POST", "/api/feedback", {"rating": "up"})
    check("反馈 up 返回 200 recorded:true",
          status == 200 and isinstance(body, dict) and body.get("recorded") is True)

    status, body = call("GET", "/api/health")
    check("健康检查含 mode/contributions/version",
          status == 200 and isinstance(body, dict)
          and body.get("mode") in ("deepseek", "offline")
          and isinstance(body.get("contributions"), dict)
          and body.get("version") == "2.0.0")

    status, body = call("GET", "/api/knowledge")
    check("知识库含 contributions.files",
          status == 200 and isinstance(body, dict)
          and isinstance(body.get("contributions"), dict)
          and isinstance(body["contributions"].get("files"), int))

    total = PASS + FAIL
    print("  结果: " + str(PASS) + "/" + str(total))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
