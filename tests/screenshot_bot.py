#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
中国计量大学校园问答助手截图脚本
================================
自动打开聊天页面，发送两个问题，等待完整回答并保存截图和回答文本。
"""
import json
import pathlib
import sys

from playwright.sync_api import expect, sync_playwright

BASE_URL = "http://localhost:3000"
ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOT_DIR = ROOT / "screenshots"
SHOT_DIR.mkdir(exist_ok=True)

Q_KNOWLEDGE = "我们学校的特色专业是什么？"
Q_OFFTOPIC = "今天杭州天气怎么样？"


def ask(page, question, timeout=60000):
    before = page.locator('[data-testid="msg-assistant"]').count()
    page.fill('[data-testid="chat-input"]', question)
    page.click('[data-testid="send-btn"]')
    page.wait_for_function(
        "n => document.querySelectorAll('[data-testid=\"msg-assistant\"]').length > n",
        arg=before,
        timeout=timeout,
    )
    page.wait_for_timeout(400)
    return page.locator('[data-testid="msg-assistant"]').last.inner_text()


def main():
    results = {}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1200, "height": 950}, device_scale_factor=2)
        page.goto(BASE_URL, wait_until="networkidle")
        page.click('[data-testid="landing-cta"]')
        expect(page.locator('[data-testid="chat-window"]')).to_be_visible()
        page.wait_for_timeout(500)

        reply_knowledge = ask(page, Q_KNOWLEDGE)
        results["knowledge_question"] = Q_KNOWLEDGE
        results["knowledge_answer"] = reply_knowledge
        page.screenshot(path=str(SHOT_DIR / "screenshot_A_knowledge.png"), full_page=True)
        print("[OK] Knowledge screenshot:", SHOT_DIR / "screenshot_A_knowledge.png")
        print("     Answer:", reply_knowledge.replace("\n", " ")[:120])

        reply_offtopic = ask(page, Q_OFFTOPIC)
        results["offtopic_question"] = Q_OFFTOPIC
        results["offtopic_answer"] = reply_offtopic
        page.screenshot(path=str(SHOT_DIR / "screenshot_B_refusal.png"), full_page=True)
        print("[OK] Refusal screenshot:", SHOT_DIR / "screenshot_B_refusal.png")
        print("     Answer:", reply_offtopic.replace("\n", " ")[:120])

        browser.close()

    (SHOT_DIR / "answers.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("[OK] Answers saved:", SHOT_DIR / "answers.json")


if __name__ == "__main__":
    sys.exit(main())
