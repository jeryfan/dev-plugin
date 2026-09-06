#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""导出整张表。默认 CSV 打到 stdout，加 -o 才写文件。流式读取，整表不进内存。

    python3 scripts/export.py user
    python3 scripts/export.py user -o ./user.csv
    python3 scripts/export.py user --where "status=1" --limit 1000 -f sql -o /tmp/user.sql
"""

import argparse
import csv as _csv
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    DbSkillError,
    _cell,
    connect,
    guard_writable,
    load_config,
    run_cli,
)


def insert_line(db, table, headers, row) -> str:
    if db.type == "mysql":
        qi = lambda s: "`{}`".format(s)  # noqa: E731
        esc = lambda v: "'{}'".format(  # noqa: E731
            str(v).replace("\\", "\\\\").replace("'", "\\'"))
    else:
        qi = lambda s: '"{}"'.format(s)  # noqa: E731
        esc = lambda v: "'{}'".format(str(v).replace("'", "''"))  # noqa: E731
    cols = ", ".join(qi(h) for h in headers)
    vals = ", ".join("NULL" if v is None else esc(v) for v in row)
    return "INSERT INTO {} ({}) VALUES ({});".format(qi(table), cols, vals)


def write_rows(db, table, fmt, headers, rows, out) -> int:
    """流式写出，返回行数。mongo 的行已是物化列表，SQL 的行是流式迭代器。"""
    fh, p = sys.stdout, None
    if out:
        p = guard_writable(out)
        if p.parent and not p.parent.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
        fh = open(p, "w", encoding="utf-8", newline="")
    n = 0
    try:
        if fmt == "csv":
            w = _csv.writer(fh)
            w.writerow([_cell(h, 4096) for h in headers])
            for r in rows:
                w.writerow([_cell(v, 4096) for v in r])
                n += 1
        elif fmt == "json":
            keys = [str(h) for h in headers]
            fh.write("[\n")
            for r in rows:
                fh.write((",\n" if n else "") + "  " + json.dumps(
                    dict(zip(keys, [_cell(v, 4096) for v in r], strict=True)),
                    ensure_ascii=False, default=str))
                n += 1
            fh.write("\n]\n")
        else:  # sql
            for r in rows:
                fh.write(insert_line(db, table, headers, r) + "\n")
                n += 1
    finally:
        if p is not None:
            fh.close()
            sys.stderr.write("已写入 {}\n".format(p))
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description="导出表数据")
    ap.add_argument("table", help="表名")
    ap.add_argument("-c", "--connection", help="连接名，默认 config.json 的 default")
    ap.add_argument("-d", "--database", help="库名，默认用连接配置里的 database")
    ap.add_argument("--where", help="WHERE 条件（不用写 WHERE）")
    ap.add_argument("--limit", type=int, default=0, help="最多导多少行，0 表示不限")
    ap.add_argument("-f", "--format", default="csv", choices=["csv", "json", "sql"])
    ap.add_argument("-o", "--out", help="输出到文件（不能落在 skill 目录里）")
    args = ap.parse_args()

    cfg = load_config()
    db = connect(args.connection, args.database, cfg)
    try:
        if db.type == "mongo":
            if args.where:
                raise DbSkillError('mongo 不支持 --where（SQL 语法）；要过滤用 q.py 的 '
                                   '{"find":"...","filter":{...}}')
            if args.format == "sql":
                raise DbSkillError("mongo 没有 SQL，导出用 -f json 或 -f csv")
            cur = db.mdb[args.table].find()
            if args.limit > 0:
                cur = cur.limit(args.limit)
            docs = list(cur)  # mongo 字段不固定，要扫完全部文档才知道完整列
            headers, seen = [], set()
            for d in docs:
                for k in d:
                    if k not in seen:
                        seen.add(k)
                        headers.append(k)
            rows = ([d.get(h) for h in headers] for d in docs)
        else:
            sql = "SELECT * FROM {}".format(db.qi(args.table))
            if args.where:
                sql += " WHERE {}".format(args.where.strip())
            if args.limit > 0:
                sql += " LIMIT {}".format(args.limit)
            headers, rows = db.stream(sql)
        n = write_rows(db, args.table, args.format, headers, rows, args.out)
    finally:
        db.close()

    sys.stderr.write("导出 {} 行 {} 列\n".format(n, len(headers)))
    return 0


if __name__ == "__main__":
    run_cli(main)
