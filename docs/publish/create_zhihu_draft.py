#!/usr/bin/env python3
"""把本地 Markdown 建成/更新知乎草稿，可选发布。"""

import argparse
import json
import re
import sys
from pathlib import Path

import markdown as md

sys.path.insert(0, "/home/chenzute/article-projects/world-model-series/scripts")
import publish_zhihu_article as P
from zhihu_cli.auth import cookie_str_to_dict
from zhihu_cli.client import ZhihuClient
from zhihu_cli.config import ZHIHU_ZHUANLAN_API


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("md_path")
    ap.add_argument("--title", default="")
    ap.add_argument("--cover", default="")
    ap.add_argument("--draft-id", default="", help="更新已有草稿时传草稿 id")
    ap.add_argument("--publish", action="store_true", help="更新后直接发布")
    ap.add_argument("--topics", default="", help="逗号分隔的知乎话题 id，如 1862547279613046600,2071646635214616004")
    args = ap.parse_args()

    md_path = Path(args.md_path)
    if not md_path.is_file():
        sys.exit(f"Markdown 不存在: {md_path}")

    cookie_str = P.load_cookie()
    text = P.strip_html_comments(md_path.read_text(encoding="utf-8"))
    lines = text.splitlines()
    title = args.title or next((ln[2:].strip() for ln in lines if ln.startswith("# ")), "")
    if not title:
        sys.exit("找不到标题")
    body = "\n".join(ln for ln in lines if not ln.startswith("# "))

    # 上传所有本地图片
    img_map: dict[str, str] = {}
    for m in re.finditer(r"!\[[^\]]*\]\(([^)]+)\)", body):
        raw = m.group(1).strip()
        if raw.startswith(("http://", "https://", "data:", "blob:")):
            continue
        p = (md_path.parent / raw).resolve()
        if p in img_map or not p.is_file():
            continue
        print(f"[img] {p.name}", flush=True)
        client = ZhihuClient(cookie_str_to_dict(cookie_str))
        info = P.upload_image_long(client, p, cookie_str)
        client.close()
        img_map[p] = P.build_img_html(info)

    def repl(match: re.Match) -> str:
        raw = match.group(1).strip()
        if raw.startswith(("http://", "https://", "data:", "blob:")):
            return match.group(0)
        p = (md_path.parent / raw).resolve()
        return img_map.get(p, match.group(0))

    body = re.sub(r"!\[[^\]]*\]\(([^)]+)\)", repl, body)
    html = md.markdown(body, extensions=["fenced_code", "tables", "sane_lists"])

    if args.cover:
        cover_path = Path(args.cover).resolve()
        print(f"[cover] {cover_path.name}", flush=True)
        client = ZhihuClient(cookie_str_to_dict(cookie_str))
        info = P.upload_image_long(client, cover_path, cookie_str)
        client.close()
        html = P.build_img_html(info) + "\n" + html

    client = ZhihuClient(cookie_str_to_dict(cookie_str))
    draft_id = args.draft_id
    if not draft_id:
        resp = client._session.post(
            f"{ZHIHU_ZHUANLAN_API}/articles/drafts", json={}, timeout=30
        )
        resp.raise_for_status()
        draft_id = resp.json().get("id", "")
        if not draft_id:
            sys.exit(f"建草稿失败: {resp.text[:300]}")
    patch_body = {"title": title, "content": html}
    if args.topics:
        patch_body["topics"] = [t.strip() for t in args.topics.split(",") if t.strip()]
    patch = client._session.patch(
        f"{ZHIHU_ZHUANLAN_API}/articles/{draft_id}/draft",
        json=patch_body,
        timeout=30,
    )
    if patch.status_code not in (200, 204):
        sys.exit(f"写草稿失败 ({patch.status_code}): {patch.text[:300]}")
    if args.publish:
        pub = client._session.put(
            f"{ZHIHU_ZHUANLAN_API}/articles/{draft_id}/publish",
            json={"column": None, "commentPermission": "anyone"},
            timeout=30,
        )
        if pub.status_code != 200:
            sys.exit(f"发布失败 ({pub.status_code}): {pub.text[:300]}")
        info = pub.json()
        print(f"PUBLISHED https://zhuanlan.zhihu.com/p/{draft_id}")
        print(json.dumps(info, ensure_ascii=False)[:300])
    else:
        print(f"DRAFT_OK id={draft_id} title={title}")
        print(f"草稿链接：https://zhuanlan.zhihu.com/p/{draft_id}")


if __name__ == "__main__":
    main()
