#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 Playwright 绕过校园网 WAF（JS 挑战）抓取中国计量大学官方页面正文。
用于补全知识库中因 WAF 拦截而缺失的数据（如校训释义）。
运行： python3 scripts/scrape_cjlu.py
输出： data/scraped.json
"""
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data"
OUT_DIR.mkdir(exist_ok=True)

PAGES = {
    "校训释义": "https://xy.cjlu.edu.cn/info/1085/41714.htm",
    "校区位置": "https://www.cjlu.edu.cn/xxzl1/xqwz.htm",
    "学校简介": "https://www.cjlu.edu.cn/xxgk/xxjj.htm",
}


def main():
    result = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
            locale="zh-CN",
        )
        page = ctx.new_page()
        for name, url in PAGES.items():
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(6000)  # 等待 WAF 的 JS 挑战自动跳转
                text = page.inner_text("body")
                result[name] = {"url": url, "text": text.strip()[:6000]}
                print("=" * 60)
                print(name, url)
                print(text.strip()[:800])
            except Exception as exc:  # noqa: BLE001
                result[name] = {"url": url, "error": str(exc)}
                print("[ERR]", name, exc)
        browser.close()

    (OUT_DIR / "scraped.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("\n[OK] 抓取结果已保存:", OUT_DIR / "scraped.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
