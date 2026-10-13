# -*- coding: utf-8 -*-
"""smoke_test.py —— 10 项核心回归"""
import sys
from common import get, post, chat, run

REFUSAL = "抱歉，我是中国计量大学的校园问答机器人"

TESTS = []


def t(label):
    def deco(fn):
        TESTS.append((label, fn))
        return fn
    return deco


@t("1. 健康检查接口")
def _():
    code, d = get("/api/health")
    assert code == 200 and d.get("ok") is True, d
    assert "retriever" in d, d


@t("2. 校园问题正常回答")
def _():
    code, d = chat("我们学校的特色专业是什么？")
    assert code == 200, (code, d)
    assert d.get("reply"), d
    assert d.get("badge") in ("knowledge", "general"), d


@t("3. 校园问题不被误拒")
def _():
    code, d = chat("中国计量大学的校训是什么？")
    assert code == 200, (code, d)
    assert REFUSAL not in d.get("reply", ""), d


@t("4. 天气问题拒答")
def _():
    code, d = chat("今天杭州天气怎么样？")
    assert code == 200, (code, d)
    assert d.get("badge") == "refusal", d
    assert REFUSAL in d.get("reply", ""), d


@t("5. 讲笑话拒答")
def _():
    code, d = chat("给我讲个笑话")
    assert d.get("badge") == "refusal", d
    assert REFUSAL in d.get("reply", ""), d


@t("6. 多轮上下文（代词指代）")
def _():
    h = [{"role": "user", "content": "中国计量大学有几个校区？"},
         {"role": "assistant", "content": "中国计量大学现有东、西两个校区。"}]
    code, d = chat("它们分别在哪里？", history=h)
    assert code == 200, (code, d)
    assert REFUSAL not in d.get("reply", ""), d


@t("7. 知识库溯源标签")
def _():
    code, d = chat("中国计量大学的校训是什么？")
    assert code == 200, (code, d)
    assert d.get("badge") == "knowledge", d
    assert "【来源：" in d.get("reply", "") or d.get("sources"), d


@t("8. 知识库接口")
def _():
    code, d = get("/api/knowledge")
    assert code == 200, (code, d)
    assert isinstance(d.get("files"), list), d


@t("9. 缺少 messages 返回 400")
def _():
    code, d = post("/api/chat", {})
    assert code == 400, (code, d)


@t("10. 空消息数组返回 400")
def _():
    code, d = post("/api/chat", {"messages": []})
    assert code == 400, (code, d)


if __name__ == "__main__":
    p, tot = run("smoke_test", TESTS)
    sys.exit(0 if p == tot else 1)
