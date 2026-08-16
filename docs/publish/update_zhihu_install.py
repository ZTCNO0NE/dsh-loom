#!/usr/bin/env python3
"""原地更新已发布知乎文章的 dsh 安装命令。"""

import sys
from pathlib import Path

from zhihu_cli.auth import cookie_str_to_dict
from zhihu_cli.client import ZhihuClient
from zhihu_cli.config import ZHIHU_ZHUANLAN_API

COOKIE_FILE = Path.home() / ".config/zhihu/cookie.txt"
ARTICLE_ID = "2072409637643612656"

REPLACEMENTS = [
    (
        "dsh plugin --profile demo add ./dsh-loom",
        "dsh plugin --profile headless add dsh-loom@1.0.2\ndsh plugin --profile headless add \"github:ZTCNO0NE/dsh-loom#main\"",
    ),
    (
        "dsh --profile demo --dump-config",
        "dsh --profile headless --dump-config",
    ),
]


def main() -> None:
    cookie = COOKIE_FILE.read_text(encoding="utf-8").strip()
    client = ZhihuClient(cookie_str_to_dict(cookie))
    try:
        url = (
            "https://www.zhihu.com/api/v4/members/lai-zhe-he-ren-shi-ke-fei-di/articles"
            "?limit=20&offset=0&sort_by=created&include=data%5B*%5D.content"
        )
        r = client._session.get(url, timeout=30)
        r.raise_for_status()
        arts = r.json().get("data", [])
        art = next((a for a in arts if str(a.get("id")) == ARTICLE_ID), None)
        if not art:
            sys.exit(f"找不到文章 {ARTICLE_ID}")

        content = art["content"]
        title = art["title"]
        changed = 0
        for old, new in REPLACEMENTS:
            if old in content:
                content = content.replace(old, new)
                changed += 1
        if changed == 0:
            sys.exit("正文没有需要替换的安装命令")

        patch_body = {
            "delta_time": 0,
            "title": title,
            "content": content,
            "titleImage": art.get("title_image", ""),
            "isTitleImageFullScreen": True,
            "table_of_contents": False,
            "can_reward": False,
        }
        pr = client._session.patch(
            f"{ZHIHU_ZHUANLAN_API}/articles/{ARTICLE_ID}/draft",
            json=patch_body,
            timeout=30,
        )
        print("patch", pr.status_code, pr.text[:200], flush=True)
        if pr.status_code not in (200, 204):
            sys.exit(f"PATCH 失败: {pr.text[:300]}")

        pu = client._session.put(
            f"{ZHIHU_ZHUANLAN_API}/articles/{ARTICLE_ID}/publish",
            json={"column": None, "commentPermission": "anyone"},
            timeout=30,
        )
        print("publish", pu.status_code, pu.text[:200], flush=True)
        if pu.status_code != 200:
            sys.exit(f"发布失败: {pu.text[:300]}")
        print(f"UPDATED https://zhuanlan.zhihu.com/p/{ARTICLE_ID}（替换 {changed} 处）")
    finally:
        client.close()


if __name__ == "__main__":
    main()
