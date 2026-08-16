#!/usr/bin/env python3
"""原地更新已发布知乎文章的仓库名与链接（不重传图片）。"""

import sys
from pathlib import Path

from zhihu_cli.auth import cookie_str_to_dict
from zhihu_cli.client import ZhihuClient
from zhihu_cli.config import ZHIHU_ZHUANLAN_API

COOKIE_FILE = Path.home() / ".config/zhihu/cookie.txt"
ARTICLE_ID = "2072409637643612656"
NEW_LINK = "https://github.com/ZTCNO0NE/dsh-loom"


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
            sys.exit(f"找不到文章 {ARTICLE_ID}，最近 {len(arts)} 篇：{[(a.get('id'), a.get('title')) for a in arts]}")

        content = art["content"]
        title = art["title"]
        before = content
        content = content.replace("dsh-meta-validate", "dsh-loom")
        content = content.replace("（GitHub 搜名字即可，地址稍后补充）", f"：<a href=\"{NEW_LINK}\">ZTCNO0NE/dsh-loom</a>")
        content = content.replace(f"项目仓库：<code>dsh-loom</code>：", f"项目仓库：<a href=\"{NEW_LINK}\">ZTCNO0NE/dsh-loom</a>")
        if content == before:
            sys.exit("正文没有需要替换的内容")

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
        print("publish", pu.status_code, pu.text[:300], flush=True)
        if pu.status_code != 200:
            sys.exit(f"发布失败: {pu.text[:300]}")
        print("UPDATED https://zhuanlan.zhihu.com/p/" + ARTICLE_ID)
    finally:
        client.close()


if __name__ == "__main__":
    main()
