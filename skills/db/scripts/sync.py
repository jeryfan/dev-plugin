#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""同步表结构到 metadata/。这是唯一允许写入 skill 目录的脚本。

    python3 scripts/sync.py                    # 同步 config.json 里配的那个库
    python3 scripts/sync.py -t user -t order   # 只同步这几张表
    python3 scripts/sync.py --all-databases    # 同步实例上所有非系统库
    python3 scripts/sync.py --prune            # 顺带清掉已删表的缓存

Mongo 没有固定 schema，按采样推断字段类型（--infer-rows 控制采样数，默认 100）。
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.dont_write_bytecode = True          # 别在 skill 目录里留下 __pycache__
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    SYSTEM_DBS,
    DbSkillError,
    connect,
    database_md_path,
    get_connection_cfg,
    load_config,
    metadata_root,
    now_iso,
    run_cli,
    sanitize,
    table_md_path,
    write_metadata_file,
)


def _sq(db, v) -> str:
    if v is None:
        return "NULL"
    s = str(v)
    s = s.replace("\\", "\\\\").replace("'", "\\'") if db.type == "mysql" else s.replace("'", "''")
    return "'" + s + "'"


# ------------------------------------------------------------------ MySQL

def mysql_databases(db, all_databases):
    if not all_databases:
        return [db.c["database"]] if db.c.get("database") else []
    _, rows = db.q("SHOW DATABASES")
    return [r[0] for r in rows if r[0] not in SYSTEM_DBS["mysql"]]


def mysql_tables(db):
    _, rows = db.q("SHOW FULL TABLES IN {}".format(db.qi(db.database)))
    return [{"schema": None, "name": r[0], "dir": r[0],
             "kind": "view" if str(r[1]).upper().startswith("VIEW") else "table"}
            for r in rows]


def mysql_collect(db, table):
    dbname = db.database
    _, rows = db.q(
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, "
        "EXTRA, COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS "
        "WHERE TABLE_SCHEMA={} AND TABLE_NAME={} ORDER BY ORDINAL_POSITION".format(
            _sq(db, dbname), _sq(db, table)))
    columns = [{"name": r[0], "type": r[1], "nullable": r[2], "default": r[3],
                "key": r[4], "extra": r[5], "comment": r[6]} for r in rows]

    idx = {}
    _, rows = db.q(
        "SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME "
        "FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA={} AND TABLE_NAME={} "
        "ORDER BY INDEX_NAME, SEQ_IN_INDEX".format(_sq(db, dbname), _sq(db, table)))
    for name, non_unique, _seq, col in rows:
        idx.setdefault(name, {"name": name, "unique": str(non_unique) == "0",
                              "columns": []})["columns"].append(col)

    ddl = ""
    _, rows = db.q("SHOW CREATE TABLE {}".format(db.qualified(table)))
    if rows and len(rows[0]) > 1:
        ddl = rows[0][1]

    comment = ""
    _, rows = db.q("SELECT TABLE_COMMENT FROM INFORMATION_SCHEMA.TABLES "
                   "WHERE TABLE_SCHEMA={} AND TABLE_NAME={}".format(
                       _sq(db, dbname), _sq(db, table)))
    if rows:
        comment = rows[0][0] or ""
    return {"columns": columns, "indexes": list(idx.values()), "ddl": ddl, "comment": comment}


# ------------------------------------------------------------------ PostgreSQL

def pg_databases(db, all_databases):
    if not all_databases:
        return [db.c["database"]] if db.c.get("database") else []
    _, rows = db.q("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1")
    return [r[0] for r in rows if r[0] not in SYSTEM_DBS["postgresql"]]


def pg_tables(db):
    schemas = list(db.c.get("schemas") or ["public"])
    ph = ", ".join(_sq(db, s) for s in schemas)
    _, rows = db.q(
        "SELECT table_schema, table_name, table_type FROM information_schema.tables "
        "WHERE table_schema IN ({}) ORDER BY 1, 2".format(ph))
    return [{"schema": r[0], "name": r[1],
             "dir": r[1] if r[0] == "public" else "{}__{}".format(r[0], r[1]),
             "kind": "view" if "VIEW" in str(r[2]).upper() else "table"} for r in rows]


def pg_collect(db, table, schema):
    _, rows = db.q(
        "SELECT ordinal_position, column_name, data_type, "
        "coalesce(character_maximum_length::text, numeric_precision::text, ''), "
        "is_nullable, column_default FROM information_schema.columns "
        "WHERE table_schema={} AND table_name={} ORDER BY ordinal_position".format(
            _sq(db, schema), _sq(db, table)))
    columns = [{"name": n, "type": t if not ln else "{}({})".format(t, ln),
                "nullable": nl, "default": d, "key": "", "extra": "", "comment": ""}
               for _p, n, t, ln, nl, d in rows]

    _, rows = db.q(
        "SELECT a.attname, col_description(a.attrelid, a.attnum) FROM pg_attribute a "
        "JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE c.relname={} AND n.nspname={} AND a.attnum > 0 AND NOT a.attisdropped".format(
            _sq(db, table), _sq(db, schema)))
    comments = {r[0]: (r[1] or "") for r in rows}
    for col in columns:
        col["comment"] = comments.get(col["name"], "")

    _, rows = db.q(
        "SELECT a.attname FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid "
        "JOIN pg_namespace n ON n.oid = t.relnamespace "
        "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) "
        "WHERE t.relname={} AND n.nspname={} AND ix.indisprimary".format(
            _sq(db, table), _sq(db, schema)))
    pk = {r[0] for r in rows}
    for col in columns:
        if col["name"] in pk:
            col["key"] = "PRI"

    idx = {}
    _, rows = db.q(
        "SELECT i.relname, ix.indisunique, a.attname, k.ord FROM pg_class t "
        "JOIN pg_index ix ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid "
        "JOIN pg_namespace n ON n.oid = t.relnamespace "
        "JOIN unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) ON true "
        "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum "
        "WHERE t.relname={} AND n.nspname={} ORDER BY i.relname, k.ord".format(
            _sq(db, table), _sq(db, schema)))
    for name, unique, col, _ord in rows:
        idx.setdefault(name, {"name": name, "unique": bool(unique),
                              "columns": []})["columns"].append(col)

    comment = ""
    _, rows = db.q(
        "SELECT obj_description(c.oid) FROM pg_class c "
        "JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE c.relname={} AND n.nspname={}".format(_sq(db, table), _sq(db, schema)))
    if rows:
        comment = rows[0][0] or ""

    lines = []
    for c in columns:
        seg = '  "{}" {}'.format(c["name"], c["type"])
        if str(c["nullable"]).upper() == "NO":
            seg += " NOT NULL"
        if c["default"]:
            seg += " DEFAULT {}".format(c["default"])
        lines.append(seg)
    for ix in idx.values():
        if ix["name"].endswith("_pkey"):
            lines.append("  PRIMARY KEY ({})".format(
                ", ".join('"{}"'.format(c) for c in ix["columns"])))
    ddl = ("-- 由 sync.py 合成（PG 没有 SHOW CREATE TABLE）\n"
           'CREATE TABLE "{}"."{}" (\n{}\n);').format(
        schema, table, ",\n".join(lines))
    return {"columns": columns, "indexes": list(idx.values()), "ddl": ddl, "comment": comment}


# ------------------------------------------------------------------ SQLite

def sqlite_tables(db):
    _, rows = db.q(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
        "AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
    return [{"schema": None, "name": r[0], "dir": r[0], "kind": r[1]} for r in rows]


def sqlite_collect(db, table):
    _, rows = db.q('PRAGMA table_info("{}")'.format(table.replace('"', '""')))
    columns = [{"name": r[1], "type": r[2] or "", "nullable": "NO" if r[3] else "YES",
                "default": r[4], "key": "PRI" if r[5] else "", "extra": "", "comment": ""}
               for r in rows]
    indexes = []
    _, rows = db.q('PRAGMA index_list("{}")'.format(table.replace('"', '""')))
    for _seq, name, unique, _origin, _partial in rows:
        _, cols = db.q('PRAGMA index_info("{}")'.format(name.replace('"', '""')))
        indexes.append({"name": name, "unique": bool(unique),
                        "columns": [c[2] for c in cols if c[2]]})
    ddl = ""
    _, rows = db.q("SELECT sql FROM sqlite_master WHERE name={} "
                   "AND type IN ('table','view')".format(_sq(db, table)))
    if rows:
        ddl = rows[0][0] or ""
    return {"columns": columns, "indexes": indexes, "ddl": ddl, "comment": ""}


# ------------------------------------------------------------------ MongoDB

def mongo_databases(db, all_databases):
    if not all_databases:
        return [db.c["database"]] if db.c.get("database") else []
    return [d for d in db.raw.list_database_names() if d not in ("admin", "config", "local")]


def mongo_tables(db):
    return [{"schema": None, "name": n, "dir": n, "kind": "collection"}
            for n in sorted(db.mdb.list_collection_names())]


def _mongo_type(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    if isinstance(v, str):
        return "string"
    if isinstance(v, datetime):
        return "date"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def mongo_collect(db, table, sample_size):
    coll = db.mdb[table]
    docs = list(coll.find().limit(max(sample_size, 1)))
    fields = {}
    for doc in docs:
        for k, v in doc.items():
            f = fields.setdefault(k, {"types": set(), "count": 0, "sample": None})
            f["count"] += 1
            f["types"].add(_mongo_type(v))
            if f["sample"] is None and v is not None:
                f["sample"] = v
    columns = []
    for k in sorted(fields, key=lambda x: (x != "_id", x)):
        v = fields[k]
        columns.append({
            "name": k,
            "type": "|".join(sorted(t for t in v["types"] if t != "null")) or "unknown",
            "nullable": "{}/{}".format(v["count"], len(docs)),
            "default": "", "key": "PRI" if k == "_id" else "",
            "extra": "", "comment": _short(v["sample"]),
        })
    indexes = [{"name": name, "unique": bool(info.get("unique")),
                "columns": [k for k, _ in info.get("key", [])]}
               for name, info in coll.index_information().items()]
    sample_doc = json.dumps(docs[0], ensure_ascii=False, indent=2, default=str) if docs else ""
    return {"columns": columns, "indexes": indexes, "ddl": sample_doc,
            "comment": "采样 {} 个文档推断的结构".format(len(docs))}


def _short(v) -> str:
    if v is None:
        return ""
    s = json.dumps(v, ensure_ascii=False, default=str) if isinstance(v, (dict, list)) else str(v)
    return s if len(s) <= 60 else s[:57] + "..."


# ------------------------------------------------------------------ 渲染

def _md(v) -> str:
    if v is None:
        return ""
    s = str(v).replace("|", "\\|").replace("\n", " ")
    return s if len(s) <= 120 else s[:117] + "..."


def render_table_md(db, database, t, info, row_count, sample) -> str:
    is_coll = t["kind"] == "collection"
    title = "{}.{}".format(database, t["name"])
    if t.get("schema") and t["schema"] != "public":
        title = "{}.{}.{}".format(database, t["schema"], t["name"])
    out = ["---",
           "connection: {}".format(db.name),
           "type: {}".format(db.type),
           "host: {}".format(db.c.get("host", "")),
           "port: {}".format(db.c.get("port", "")),
           "database: {}".format(database),
           "schema: {}".format(t.get("schema") or ""),
           "table: {}".format(t["name"]),
           "kind: {}".format(t["kind"]),
           "row_count: {}".format("" if row_count is None else row_count),
           "synced_at: {}".format(now_iso()),
           "---", "", "# {}".format(title), ""]
    if info.get("comment"):
        out += ["> {}".format(str(info["comment"]).replace("\n", " ")), ""]

    if is_coll:
        out += ["## 字段（采样推断）", "",
                "| # | 字段 | 类型 | 出现率 | 键 | 样例值 |",
                "|---|------|------|--------|-----|--------|"]
        for i, c in enumerate(info["columns"], 1):
            out.append("| {} | `{}` | {} | {} | {} | {} |".format(
                i, c["name"], _md(c["type"]), _md(c["nullable"]),
                _md(c["key"]), _md(c["comment"])))
        out.append("")
    else:
        out += ["## 列", "",
                "| # | 字段 | 类型 | NULL | 默认值 | 键 | 说明 |",
                "|---|------|------|------|--------|-----|------|"]
        for i, c in enumerate(info["columns"], 1):
            out.append("| {} | `{}` | {} | {} | {} | {} | {} |".format(
                i, c["name"], _md(c["type"]), _md(c["nullable"]),
                _md(c["default"]), _md(c["key"]), _md(c["comment"])))
        out.append("")

    out += ["## 索引", ""]
    if info["indexes"]:
        out += ["| 索引名 | 列 | 唯一 |", "|--------|-----|------|"]
        for ix in info["indexes"]:
            out.append("| `{}` | {} | {} |".format(
                ix["name"], ", ".join("`{}`".format(c) for c in ix["columns"]),
                "是" if ix.get("unique") else "否"))
    else:
        out.append("（无）")
    out.append("")

    out += ["## {}".format("示例文档（采样）" if is_coll else "DDL"), "",
            "```json" if is_coll else "```sql",
            (info.get("ddl") or "-- 未获取到").rstrip(),
            "```", ""]

    if sample and sample[1]:
        headers, rows = sample
        out += ["## 样例数据（前 {} 行）".format(len(rows)), "",
                "| " + " | ".join(str(h) for h in headers) + " |",
                "|" + "|".join(["---"] * len(headers)) + "|"]
        out += ["| " + " | ".join(_md(v) for v in r) + " |" for r in rows]
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def render_database_md(db, database, entries) -> str:
    out = ["---",
           "connection: {}".format(db.name),
           "type: {}".format(db.type),
           "database: {}".format(database),
           "table_count: {}".format(len(entries)),
           "synced_at: {}".format(now_iso()),
           "---", "",
           "# {} @ {}{}".format(database, db.c.get("host", db.type),
                                ":{}".format(db.c.get("port")) if db.c.get("port") else ""),
           "",
           "| 表 | 类型 | 行数 | 说明 |", "|----|------|------|------|"]
    for e in entries:
        out.append("| [{}]({}/table.md) | {} | {} | {} |".format(
            e["name"], sanitize(e["dir"]), e["kind"],
            "" if e["row_count"] is None else e["row_count"], _md(e["comment"])))
    out += ["", "> 本文件由 sync.py 生成，不要手工编辑。", ""]
    return "\n".join(out)


# ------------------------------------------------------------------ 主流程

def sync_connection(cfg, name, args) -> dict:
    stat = {"databases": 0, "tables": 0, "created": 0, "updated": 0,
            "unchanged": 0, "pruned": 0}
    c = get_connection_cfg(cfg, name)
    typ = str(c.get("type") or "").lower()

    if typ in ("sqlite", "sqlite3"):
        db = connect(name, None, cfg)
        databases, per_db = [db.database], False
    else:
        probe = connect(name, None, cfg)
        if typ == "mysql":
            databases = mysql_databases(probe, args.all_databases)
        elif typ in ("mongo", "mongodb"):
            databases = mongo_databases(probe, args.all_databases)
        else:
            databases = pg_databases(probe, args.all_databases)
        probe.close()
        per_db = True
    if args.database:
        want = set(args.database)
        databases = [d for d in databases if d in want]
    if not databases:
        raise DbSkillError(
            "没找到要同步的库：config.json 里没写 database。\n"
            "  填上默认库，或加 --all-databases 同步实例上所有非系统库")

    for database in databases:
        db = connect(name, database, cfg) if per_db else db
        if typ == "mysql":
            tables = mysql_tables(db)
            collect = lambda t, db=db: mysql_collect(db, t["name"])  # noqa: E731
        elif typ == "postgresql":
            tables = pg_tables(db)
            collect = lambda t, db=db: pg_collect(db, t["name"], t["schema"])  # noqa: E731
        elif typ in ("mongo", "mongodb"):
            tables = mongo_tables(db)
            collect = lambda t, db=db: mongo_collect(db, t["name"], args.infer_rows)  # noqa: E731
        else:
            tables = sqlite_tables(db)
            collect = lambda t, db=db: sqlite_collect(db, t["name"])  # noqa: E731

        if not args.views:
            tables = [t for t in tables if t["kind"] != "view"]
        if args.table:
            want_t = set(args.table)
            tables = [t for t in tables if t["name"] in want_t]

        entries, written = [], set()
        for t in tables:
            info = collect(t)
            row_count = None
            if not args.no_row_count:
                try:
                    if db.type == "mongo":
                        row_count = db.mdb[t["name"]].count_documents({})
                    else:
                        row_count = db.one("SELECT COUNT(*) FROM {}".format(
                            db.qualified(t["name"], t["schema"])))
                except Exception as e:
                    sys.stderr.write("  跳过行数统计 {}: {}\n".format(t["name"], e))
            sample = None
            if args.sample_rows > 0 and db.type != "mongo":
                try:
                    sample = db.q("SELECT * FROM {} LIMIT {}".format(
                        db.qualified(t["name"], t["schema"]), args.sample_rows))
                except Exception as e:
                    sys.stderr.write("  跳过样例数据 {}: {}\n".format(t["name"], e))

            path = table_md_path(cfg, db.host_dir, database, t["dir"])
            state = write_metadata_file(
                path, render_table_md(db, database, t, info, row_count, sample))
            stat[state] += 1
            stat["tables"] += 1
            written.add(sanitize(t["dir"]))
            entries.append({"name": t["name"], "dir": t["dir"], "kind": t["kind"],
                            "row_count": row_count, "comment": info.get("comment", "")})
            if not args.quiet:
                print("  [{}] {}".format(state[:3], path.relative_to(metadata_root(cfg))))

        if not args.table:
            write_metadata_file(database_md_path(cfg, db.host_dir, database),
                                render_database_md(db, database, entries))
        stat["databases"] += 1

        if args.prune and not args.table:
            dbroot = metadata_root(cfg) / db.host_dir / sanitize(database)
            if dbroot.exists():
                for child in sorted(dbroot.iterdir()):
                    if not child.is_dir() or child.name in written:
                        continue
                    md = child / "table.md"
                    if md.exists():
                        md.unlink()
                        try:
                            child.rmdir()
                        except OSError:
                            pass
                        stat["pruned"] += 1
                        print("  [prune] {}".format(child.relative_to(metadata_root(cfg))))
        if per_db:
            db.close()
    if not per_db:
        db.close()
    return stat


def main() -> int:
    ap = argparse.ArgumentParser(description="同步表结构到 metadata/")
    ap.add_argument("-c", "--connection", help="连接名，默认 config.json 的 default")
    ap.add_argument("-d", "--database", action="append", help="只同步指定库，可重复")
    ap.add_argument("-t", "--table", action="append", help="只同步指定表，可重复")
    ap.add_argument("--all-databases", action="store_true", help="同步实例上所有非系统库")
    ap.add_argument("--views", action="store_true", help="连视图一起同步")
    ap.add_argument("--sample-rows", type=int, default=0, help="每张表缓存几行样例数据")
    ap.add_argument("--infer-rows", type=int, default=100, help="mongo 推断字段类型的采样文档数")
    ap.add_argument("--no-row-count", action="store_true", help="跳过 COUNT(*)（大表更快）")
    ap.add_argument("--prune", action="store_true", help="清掉已删表的缓存")
    ap.add_argument("-q", "--quiet", action="store_true")
    args = ap.parse_args()

    cfg = load_config()
    # 不指定 -c 时只同步 default 那个连接，避免把 example 里的占位连接也跑一遍
    names = [args.connection] if args.connection else (
        [cfg["default"]] if cfg.get("default") else list(cfg["connections"].keys()))
    print("元数据目录: {}".format(metadata_root(cfg)))
    total = {"created": 0, "updated": 0, "unchanged": 0, "pruned": 0, "tables": 0}
    failed = False
    for name in names:
        print("== {} ==".format(name))
        try:
            st = sync_connection(cfg, name, args)
            for k in total:
                total[k] += st.get(k, 0)
            print("  {} 张表：新增 {} 更新 {} 未变 {} 清理 {}".format(
                st["tables"], st["created"], st["updated"], st["unchanged"], st["pruned"]))
        except Exception as e:
            failed = True
            sys.stderr.write("db: {} 同步失败: {}\n".format(name, e))
    print("合计：新增 {} 更新 {} 未变 {} 清理 {}".format(
        total["created"], total["updated"], total["unchanged"], total["pruned"]))
    return 1 if failed else 0


if __name__ == "__main__":
    run_cli(main)
