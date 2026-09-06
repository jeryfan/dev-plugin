#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只读查询：关系库写 SQL（SELECT/SHOW/DESC/EXPLAIN/WITH），Mongo 写 runCommand 的 JSON。

    python3 scripts/q.py "select * from user limit 5"
    python3 scripts/q.py '{"find":"user","filter":{"status":1},"limit":5}'
    python3 scripts/q.py "select * from user" -f csv -o /tmp/user.csv
    echo "select count(*) from user" | python3 scripts/q.py

写操作请用 scripts/exec.py。
"""

import argparse
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    MAX_ROWS,
    DbSkillError,
    assert_readonly,
    connect,
    get_connection_cfg,
    load_config,
    print_rows,
    run_cli,
)


def main() -> int:
    ap = argparse.ArgumentParser(description="只读 SQL 查询")
    ap.add_argument("sql", nargs="?", help="SQL 语句；省略则从 stdin 读")
    ap.add_argument("--file", help="读 SQL 文件")
    ap.add_argument("-c", "--connection", help="连接名，默认 config.json 的 default")
    ap.add_argument("-d", "--database", help="库名，默认用连接配置里的 database")
    ap.add_argument("-f", "--format", default="table",
                    choices=["table", "json", "csv", "markdown"])
    ap.add_argument("--max-rows", type=int, default=MAX_ROWS, help="打印上限，0 表示不限")
    ap.add_argument("-o", "--out", help="输出到文件（不能落在 skill 目录里）")
    args = ap.parse_args()

    if args.sql:
        sql = args.sql
    elif args.file:
        p = Path(args.file).expanduser()
        if not p.exists():
            raise DbSkillError("SQL 文件不存在: {}".format(p))
        sql = p.read_text(encoding="utf-8")
    elif not sys.stdin.isatty():
        sql = sys.stdin.read()
    else:
        raise DbSkillError("要给一条 SQL，或用管道输入")

    sql = sql.strip().rstrip(";")
    if not sql:
        raise DbSkillError("SQL 是空的")

    cfg = load_config()
    typ = str(get_connection_cfg(cfg, args.connection).get("type") or "").lower()
    assert_readonly(sql, "mongo" if typ in ("mongo", "mongodb") else "sql")

    db = connect(args.connection, args.database, cfg)
    try:
        # 多取一行来判断是否截断，流式读取，不把整表拉进内存
        limit = args.max_rows + 1 if args.max_rows > 0 else 0
        headers, rows = db.q(sql, limit=limit)
    finally:
        db.close()

    truncated = args.max_rows > 0 and len(rows) > args.max_rows
    if truncated:
        rows = rows[:args.max_rows]
    print_rows(headers, rows, args.format, args.out)
    if truncated:
        sys.stderr.write(
            "注意：只打印了前 {} 行（--max-rows 0 可取消限制）\n".format(args.max_rows))
    return 0


if __name__ == "__main__":
    run_cli(main)
