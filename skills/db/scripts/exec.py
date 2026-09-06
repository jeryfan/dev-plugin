#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""写操作（INSERT / UPDATE / DELETE / DDL；Mongo 是 runCommand 的 JSON）。
不加 --yes 就只打印计划，不执行。

    python3 scripts/exec.py "update user set status=1 where id=3"        # 干跑
    python3 scripts/exec.py "update user set status=1 where id=3" --yes  # 真跑
    python3 scripts/exec.py --file /tmp/patch.sql --yes                  # 多语句，单事务
    python3 scripts/exec.py '{"delete":"user","deletes":[{"q":{"_id":1},"limit":1}]}' --yes
    python3 scripts/exec.py "delete from log where day < '2026-01-01'" --yes --no-commit
"""

import argparse
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    DbSkillError,
    connect,
    get_connection_cfg,
    load_config,
    run_cli,
    split_statements,
)

DANGER = ("drop", "truncate", "alter", "delete", "update", "grant", "revoke")
MONGO_DANGER = ("drop", "delete", "update", "rename", "findandmodify", "insert")


def read_sql(args) -> str:
    if args.sql:
        return args.sql
    if args.file:
        p = Path(args.file).expanduser()
        if not p.exists():
            raise DbSkillError("SQL 文件不存在: {}".format(p))
        return p.read_text(encoding="utf-8")
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise DbSkillError("要给一条 SQL，或用 --file / 管道输入")


def _conn_type(cfg, name):
    return str(get_connection_cfg(cfg, name).get("type") or "").lower()


def _parse_mongo(text):
    try:
        obj = json.loads(text)
    except ValueError as e:
        raise DbSkillError(
            "mongo 语句必须是 JSON（一条命令对象，或命令数组）: {}".format(e)) from None
    cmds = obj if isinstance(obj, list) else [obj]
    if not cmds or not all(isinstance(c, dict) and c for c in cmds):
        raise DbSkillError("mongo 命令必须是 JSON 对象")
    return cmds


def main() -> int:
    ap = argparse.ArgumentParser(description="写操作（默认干跑）")
    ap.add_argument("sql", nargs="?", help="SQL 或 mongo JSON 命令；省略则从 stdin 读")
    ap.add_argument("--file", help="读语句文件；SQL 多条按单事务执行")
    ap.add_argument("-c", "--connection", help="连接名，默认 config.json 的 default")
    ap.add_argument("-d", "--database", help="库名，默认用连接配置里的 database")
    ap.add_argument("--yes", action="store_true", help="确认执行；不加则只打印计划")
    ap.add_argument("--no-commit", action="store_true", help="执行后回滚，用来验证影响范围")
    args = ap.parse_args()

    cfg = load_config()
    text = read_sql(args)
    is_mongo = _conn_type(cfg, args.connection) in ("mongo", "mongodb")

    if is_mongo:
        cmds = _parse_mongo(text)
        show = [json.dumps(c, ensure_ascii=False) for c in cmds]
        danger = any(str(next(iter(c), "")).lower().startswith(MONGO_DANGER) for c in cmds)
    else:
        cmds = split_statements(text)
        if not cmds:
            raise DbSkillError("没解析出可执行的语句")
        show = [" ".join(s.split()) for s in cmds]
        danger = any(s.lstrip().lower().startswith(DANGER) for s in cmds)

    print("连接  : {}".format(args.connection or cfg.get("default") or "默认"))
    print("库    : {}".format(args.database or "（连接默认库）"))
    print("语句  : {} 条".format(len(cmds)))
    for i, s in enumerate(show, 1):
        print("  {}) {}".format(i, s[:160]))
    if danger:
        print("警告  : 含 DROP / DELETE / UPDATE 等危险命令，先确认影响范围")
    if args.no_commit:
        print("模式  : {}"
              .format("mongo 无客户端事务，--no-commit 不生效，命令会直接生效"
                      if is_mongo else "执行后回滚（--no-commit）"))
    if not args.yes:
        print("\n没执行。确认无误后加 --yes（只读查询用 q.py）")
        return 0

    db = connect(args.connection, args.database, cfg)
    try:
        if is_mongo:
            total = 0
            for i, c in enumerate(cmds, 1):
                n, res = db.mongo_exec(c)
                total += n
                print("  {}) 影响 {} 行  {}".format(
                    i, n, json.dumps(res, ensure_ascii=False, default=str)[:200]))
            print("\n已执行 {} 条命令，累计影响 {} 行".format(len(cmds), total))
        else:
            total = 0
            for i, s in enumerate(cmds, 1):
                n = db.exec(s, commit=False)
                total += n
                print("  {}) 影响 {} 行".format(i, n))
            if args.no_commit:
                db.raw.rollback()
                print("\n已回滚（--no-commit），累计影响 {} 行".format(total))
            else:
                db.raw.commit()
                print("\n已提交，累计影响 {} 行".format(total))
        return 0
    except Exception:
        if not is_mongo:
            try:
                db.raw.rollback()
                sys.stderr.write("db: 出错已回滚\n")
            except Exception:
                pass
        raise
    finally:
        db.close()


if __name__ == "__main__":
    run_cli(main)
