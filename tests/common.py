# -*- coding: utf-8 -*-
"""测试公共工具：零第三方依赖，基于标准库 urllib。"""
import json
import os
import urllib.request
import urllib.error

BASE = os.environ.get("BASE_URL", "http://localhost:3000")


def _req(method, path, payload=None, timeout=90):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8")
            return r.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as e:
        try:
            d = json.loads(e.read().decode("utf-8"))
        except Exception:
            d = {}
        return e.code, d
    except Exception as e:
        return 0, {"error": str(e)}


def get(path, timeout=90):
    return _req("GET", path, timeout=timeout)


def post(path, payload, timeout=90):
    return _req("POST", path, payload, timeout=timeout)


def chat(question, history=None, timeout=90):
    messages = list(history or [])
    messages.append({"role": "user", "content": question})
    return post("/api/chat", {"messages": messages}, timeout=timeout)


def run(name, tests):
    passed = 0
    total = len(tests)
    print("\n=== " + name + " ===")
    for label, fn in tests:
        try:
            fn()
            print("  [PASS] " + label)
            passed += 1
        except AssertionError as e:
            print("  [FAIL] " + label + "  -> " + str(e))
        except Exception as e:
            print("  [FAIL] " + label + "  -> " + repr(e))
    print("  结果: " + str(passed) + "/" + str(total))
    return passed, total
