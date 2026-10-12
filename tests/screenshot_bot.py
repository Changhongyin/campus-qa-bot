#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
中国计量大学校园问答机器人 —— 自动化截图脚本 (Playwright)
================================================================
功能：
  1. 自动打开 http://localhost:3000 的聊天页面；
  2. 自动提问并等待机器人回答；
  3. 截图A："我们学校的特色专业是什么？" -> 验证本地知识库
     截图B："今天杭州天气怎么样？"       -> 验证拒答非校园问题
  4. 截图保存到 screenshots/ 目录，并把回答文本写入 screenshots/answers.json

运行： python3 tests/screenshot_bot.py
依赖： pip install playwright && python -m playwright install chromium
"""
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright, expect

BASE_URL = "http://localhost:3000"
ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOT_DIR = ROOT / "screenshots"
SHOT_DIR.mkdir(exist_ok=True)

Q_KNOWLEDGE = "我们学校的特色专业是什么？"
Q_OFFTOPIC = "今天杭州天气怎么样？"


def ask(page, question, timeout=60000):
    """在聊天框输入问题并点击发送，等待机器人回复完成，返回回复文本。"""
    before = page.locator('[data-testid="msg-assistant"]').count()
    page.fill('[data-testid="chat-input"]', question)
    page.click('[data-testid="send-btn"]')
    page.wait_for_function(
        "n => document.querySelectorAll('[data-testid=\"msg-assistant\"]').length > n",
        arg=before,
        timeout=timeout,
    )
    page.wait_for_timeout(400)  # 等动画结束
    return page.locator('[data-testid="msg-assistant"]').last.inner_text()


def main():
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1200, "height": 950}, device_scale_factor=2)
        page.goto(BASE_URL, wait_until="networkidle")
        expect(page.locator('[data-testid="chat-window"]')).to_be_visible()
        page.wait_for_timeout(500)

        # ---------- 截图A：验证知识库 ----------
        reply_a = ask(page, Q_KNOWLEDGE)
        results["knowledge_question"] = Q_KNOWLEDGE
        results["knowledge_answer"] = reply_a
        page.screenshot(path=str(SHOT_DIR / "screenshot_A_knowledge.png"), full_page=True)
        print("[OK] 截图A 已生成:", SHOT_DIR / "screenshot_A_knowledge.png")
        print("     机器人回答:", reply_a.replace("\n", " ")[:120])

        # ---------- 截图B：验证拒答 ----------
        reply_b = ask(page, Q_OFFTOPIC)
        results["offtopic_question"] = Q_OFFTOPIC
        results["offtopic_answer"] = reply_b
        page.screenshot(path=str(SHOT_DIR / "screenshot_B_refusal.png"), full_page=True)
        print("[OK] 截图B 已生成:", SHOT_DIR / "screenshot_B_refusal.png")
        print("     机器人回答:", reply_b.replace("\n", " ")[:120])

        browser.close()

    (SHOT_DIR / "answers.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("[OK] 回答文本已保存:", SHOT_DIR / "answers.json")


if __name__ == "__main__":
    sys.exit(main())
