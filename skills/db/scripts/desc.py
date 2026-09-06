#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""看表结构：读 metadata/ 缓存，不连数据库。

    python3 scripts/desc.py                  # 列出已缓存的所有表
    python3 scripts/desc.py user             # 看 user 表的结构
    python3 scripts/desc.py user --section ddl
    python3 scripts/desc.py user --path      # 只打印文件路径

没缓存就先跑 scripts/sync.py。
"""

import argparse
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    SKILL_DIR,
    DbSkillError,
    get_connection_cfg,
    host_dir,
    load_config,
    metadata_root,
    run_cli,
    sanitize,
)


def iter_table_files(cfg, connection=None, database=None, table=None):
    root = metadata_root(cfg)
    if not root.exists():
        raise DbSkillError("还没有任何缓存，先跑: python3 {}/scripts/sync.py".format(SKILL_DIR))
    if connection:
        c = get_connection_cfg(cfg, connection)
        hosts = [sanitize(host_dir(c, str(c.get("type") or "").lower()))]
    else:
        hosts = [p.name for p in sorted(root.iterdir()) if p.is_dir()]

    want_db = sanitize(database) if database else None
    want_tb = sanitize(table) if table else None
    found = []
    for host in hosts:
        hdir = root / host
        if not hdir.is_dir():
            continue
        for dbdir in sorted(p for p in hdir.iterdir() if p.is_dir()):
            if want_db and dbdir.name != want_db:
                continue
            for child in sorted(dbdir.iterdir()):
                cands = []
                if child.is_dir() and (child / "table.md").exists():
                    cands.append(child / "table.md")
                elif child.is_file() and child.suffix == ".md" and not child.name.startswith("_"):
                    cands.append(child)
                for md in cands:
                    name = md.parent.name if md.name == "table.md" else md.stem
                    if want_tb and name != want_tb:
                        continue
                    found.append({"host": host, "database": dbdir.name,
                                  "table": name, "path": md})
    return found


def sections(text: str) -> dict:
    parts, cur, buf = {}, None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if cur:
                parts[cur] = "\n".join(buf).rstrip()
            cur, buf = line[3:].strip(), []
        elif cur is not None:
            buf.append(line)
    if cur:
        parts[cur] = "\n".join(buf).rstrip()
    return parts


def main() -> int:
    ap = argparse.ArgumentParser(description="看表结构（读缓存，不连库）")
    ap.add_argument("table", nargs="?", help="表名；省略则列出已缓存的表")
    ap.add_argument("-c", "--connection", help="连接名")
    ap.add_argument("-d", "--database", help="库名")
    ap.add_argument("--section", help="只看某个小节，如 列 / 索引 / DDL")
    ap.add_argument("--raw", action="store_true", help="输出整个文件（含 frontmatter）")
    ap.add_argument("--path", action="store_true", help="只打印文件路径")
    args = ap.parse_args()

    cfg = load_config()
    found = iter_table_files(cfg, args.connection, args.database, args.table)
    if not found:
        raise DbSkillError(
            "没找到 {} 的缓存，先跑: python3 {}/scripts/sync.py".format(
                args.table or "任何表", SKILL_DIR))

    if not args.table:
        w = max(len(f["table"]) for f in found)
        for f in found:
            print("{}/{}  {}  {}".format(f["host"], f["database"],
                                         f["table"].ljust(w + 2), f["path"]))
        print("\n({} 张表)".format(len(found)))
        return 0

    if len(found) > 1:
        print("匹配到多个，用 -c / -d 缩小范围：")
        for f in found:
            print("  {}/{}/{}".format(f["host"], f["database"], f["table"]))
        return 1

    md = found[0]["path"]
    if args.path:
        print(md)
        return 0
    text = md.read_text(encoding="utf-8")
    if args.raw:
        print(text.rstrip())
        return 0
    if args.section:
        parts = sections(text)
        keys = [k for k in parts if args.section.lower() in k.lower()]
        if not keys:
            raise DbSkillError("没有叫 {} 的小节；可用: {}"
                               .format(args.section, " / ".join(parts) or "（无）"))
        print("# {}\n\n{}".format(keys[0], parts[keys[0]]))
        return 0
    if text.startswith("---"):  # 去掉 frontmatter
        end = text.find("\n---", 3)
        if end > 0:
            print(text[end + 4:].lstrip("\n").rstrip())
            return 0
    print(text.rstrip())
    return 0


if __name__ == "__main__":
    run_cli(main)
