#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""db skill 公共库：配置、连接、路径、输出、写入护栏。

scripts/ 下的脚本 import 它；一次性脚本从临时目录只读 import：

    import sys
    sys.path.insert(0, "<skill>/scripts")
    from _common import connect, print_rows

命令行：
    python3 _common.py --doctor     检查配置与驱动
    python3 _common.py --tmp-dir    建一个临时目录（给一次性脚本用）
"""

import argparse
import csv as _csv
import io
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
CONFIG_ENV = "DB_SKILL_CONFIG"
MAX_ROWS = 200  # q.py 默认打印上限

SYSTEM_DBS = {
    "mysql": {"information_schema", "mysql", "performance_schema", "sys"},
    "postgresql": {"postgres", "template0", "template1"},
}
READONLY_HEAD = re.compile(
    r"^(select|show|desc|describe|explain|with|pragma|table|values)\b", re.I
)
MONGO_READ_ONLY = {
    "find", "count", "distinct", "aggregate", "estimatedDocumentCount",
    "listCollections", "listIndexes", "dbStats", "collStats", "explain", "getMore",
}


class DbSkillError(Exception):
    """可预期的错误：打印到 stderr 后 exit 1。"""


def run_cli(main_fn) -> None:
    try:
        sys.exit(main_fn())
    except DbSkillError as e:
        sys.stderr.write("db: {}\n".format(e))
        sys.exit(1)
    except KeyboardInterrupt:
        sys.stderr.write("db: 已中断\n")
        sys.exit(130)
    except Exception as e:
        sys.stderr.write("db: {}: {}\n".format(type(e).__name__, e))
        sys.exit(1)


# ------------------------------------------------------------------ 配置

def config_path() -> Path:
    env = os.environ.get(CONFIG_ENV)
    return Path(os.path.expandvars(env)).expanduser() if env else SKILL_DIR / "config.json"


def _expand_env(obj):
    if isinstance(obj, str):
        return os.path.expandvars(obj)
    if isinstance(obj, dict):
        return {k: _expand_env(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_expand_env(v) for v in obj]
    return obj


def load_config() -> dict:
    path = config_path()
    if not path.exists():
        raise DbSkillError(
            "缺少配置文件 {}\n  复制模板后填写连接信息: cp {} {}".format(
                path, SKILL_DIR / "config.example.json", path))
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        raise DbSkillError("配置文件解析失败 {}: {}".format(path, e)) from e
    conns = cfg.get("connections")
    if not isinstance(conns, dict) or not conns:
        raise DbSkillError("{} 里没有写 connections".format(path))
    return _expand_env(cfg)


def get_connection_cfg(cfg: dict, name: str | None = None) -> dict:
    conns = cfg["connections"]
    if not name:
        name = cfg.get("default")
    if not name and len(conns) == 1:
        name = next(iter(conns))
    if not name or name not in conns:
        raise DbSkillError("未指定连接{}；config.json 里有: {}".format(
            "" if not name else "（{} 不存在）".format(name), ", ".join(conns)))
    c = dict(conns[name])
    c["_name"] = name
    return c


# ------------------------------------------------------------------ 路径

def sanitize(value) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", str(value)).strip("_").lower()
    return s or "_"


def host_dir(c: dict, typ: str = "") -> str:
    """metadata 一级目录：alias > sqlite > <host>_<port>。"""
    if c.get("alias"):
        return sanitize(c["alias"])
    if typ in ("sqlite", "sqlite3"):
        return "sqlite"
    return "{}_{}".format(sanitize(c.get("host", "host")), sanitize(c.get("port", "")))


def metadata_root(cfg: dict | None = None) -> Path:
    if cfg is None:
        try:
            cfg = load_config()
        except DbSkillError:
            cfg = {}
    d = str((cfg.get("metadata_dir") or "metadata"))
    p = Path(os.path.expandvars(d)).expanduser()
    return p if p.is_absolute() else (SKILL_DIR / p)


def table_md_path(cfg, host: str, database: str, table_dir: str) -> Path:
    return metadata_root(cfg) / host / sanitize(database) / sanitize(table_dir) / "table.md"


def database_md_path(cfg, host: str, database: str) -> Path:
    return metadata_root(cfg) / host / sanitize(database) / "_database.md"


def _resolve(p: Path) -> Path:
    try:
        return p.resolve()
    except OSError:
        return p.absolute()


def guard_writable(path, allow_metadata: bool = False) -> Path:
    """禁止任何输出落到 skill 目录内（metadata/ 例外，且需显式允许）。

    这是 skill 目录不被临时文件污染的最后一道硬防线。
    """
    p = _resolve(Path(os.path.expandvars(str(path))).expanduser())
    root = _resolve(SKILL_DIR)
    if not (p == root or root in p.parents):
        return p
    if allow_metadata:
        mroot = _resolve(metadata_root())
        if p == mroot or mroot in p.parents:
            return p
    raise DbSkillError(
        "禁止写入 skill 目录: {}\n"
        "  skill 目录只允许两类写入：metadata/（仅 sync.py）和 config.json（手工维护）\n"
        "  请把 -o 指到项目目录或 {}/ 下".format(p, tempfile.gettempdir()))


def _comparable(text: str) -> str:
    """比较时忽略 synced_at 行，结构没变就不写盘。"""
    return "\n".join(line for line in text.splitlines() if not line.startswith("synced_at:"))


def write_metadata_file(path, text: str) -> str:
    p = guard_writable(path, allow_metadata=True)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        try:
            if _comparable(p.read_text(encoding="utf-8")) == _comparable(text):
                return "unchanged"
        except OSError:
            pass
        p.write_text(text, encoding="utf-8")
        return "updated"
    p.write_text(text, encoding="utf-8")
    return "created"


def output(text: str, out=None) -> None:
    if not out:
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
        return
    p = guard_writable(out)
    if p.parent and not p.parent.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    sys.stderr.write("已写入 {}\n".format(p))


# ------------------------------------------------------------------ 输出

def _cell(v, max_cell: int) -> str:
    if v is None:
        s = "NULL"
    elif isinstance(v, bytes):
        s = v.decode("utf-8", "replace")
    elif isinstance(v, bool):
        s = "true" if v else "false"
    else:
        s = str(v)
    s = s.replace("\n", "\\n").replace("\r", "")
    return s if len(s) <= max_cell else s[: max_cell - 3] + "..."


def format_rows(headers, rows, fmt: str = "table", max_cell: int = 80) -> str:
    headers = [_cell(h, max_cell) for h in headers]
    rows = [[_cell(v, max_cell) for v in r] for r in rows]
    if fmt in ("json", "jsonl"):
        return json.dumps([dict(zip(headers, r, strict=True)) for r in rows],
                          ensure_ascii=False, indent=2, default=str)
    if fmt == "csv":
        buf = io.StringIO()
        w = _csv.writer(buf)
        w.writerow(headers)
        w.writerows(rows)
        return buf.getvalue()
    if fmt == "markdown":
        out = ["| " + " | ".join(headers) + " |",
               "|" + "|".join(["---"] * len(headers)) + "|"]
        out += ["| " + " | ".join(r) + " |" for r in rows]
        return "\n".join(out) + "\n"
    widths = [len(h) for h in headers]
    for r in rows:
        for i, v in enumerate(r):
            if i < len(widths):
                widths[i] = max(widths[i], len(v))
    line = "+-" + "-+-".join("-" * w for w in widths) + "-+"
    out = [line, "| " + " | ".join(h.ljust(widths[i]) for i, h in enumerate(headers)) + " |", line]
    out += ["| " + " | ".join(r[i].ljust(widths[i]) for i in range(len(widths))) + " |"
            for r in rows]
    out.append(line)
    out.append("({} 行)".format(len(rows)))
    return "\n".join(out)


def print_rows(headers, rows, fmt: str = "table", out=None, max_cell: int = 80) -> None:
    output(format_rows(headers, rows, fmt, max_cell), out)


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ------------------------------------------------------------------ SQL

def assert_readonly(stmt, typ: str = "sql") -> None:
    if typ == "mongo":
        try:
            cmd = json.loads(stmt) if isinstance(stmt, str) else stmt
        except ValueError as e:
            raise DbSkillError("mongo 命令必须是 JSON 对象，"
                               "如 '{{\"find\":\"user\",\"limit\":5}}'：{}".format(e)) from None
        if not isinstance(cmd, dict) or not cmd:
            raise DbSkillError("mongo 命令必须是 JSON 对象")
        name = next(iter(cmd), "")
        if name not in MONGO_READ_ONLY:
            raise DbSkillError(
                "q.py 只跑只读 mongo 命令（{}）；写操作用 exec.py".format(
                    " / ".join(sorted(MONGO_READ_ONLY))))
        return
    s = re.sub(r"/\*.*?\*/", " ", stmt, flags=re.S)
    s = re.sub(r"--[^\n]*", " ", s)
    s = re.sub(r"#[^\n]*", " ", s)  # MySQL 的 # 注释
    stmts = split_statements(s)
    if len(stmts) > 1:
        raise DbSkillError("q.py 一次只跑一条语句；多条请分开跑，写操作用 exec.py")
    s = (stmts[0] if stmts else s).strip().lstrip("(").strip()
    if not READONLY_HEAD.match(s):
        raise DbSkillError(
            "q.py 只跑只读语句（SELECT / SHOW / DESC / EXPLAIN / WITH）；写操作用 exec.py")
    if s[:4].lower() == "with" and re.search(
            r"\b(insert|update|delete|merge|create|drop|alter|truncate)\b", s, re.I):
        raise DbSkillError("WITH 里不允许写操作（可写 CTE）；请用 exec.py --yes")


def split_statements(text: str) -> list:
    out, buf, quote = [], [], None
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and quote in ("'", '"') and i + 1 < n:
                buf.append(text[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "-" and text.startswith("--", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == ";":
            out.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    if "".join(buf).strip():
        out.append("".join(buf))
    return [s.strip() for s in out if s.strip() and not s.strip().startswith("--")]


# ------------------------------------------------------------------ 连接

def _import_driver(mod: str, hint: str):
    try:
        return __import__(mod)
    except ImportError as e:
        raise DbSkillError("缺少驱动 {}: {}\n  安装: {}".format(mod, e, hint)) from None


def _resolve_password(c: dict) -> str:
    if c.get("password_env"):
        env = c["password_env"]
        val = os.environ.get(env)
        if val is None:
            raise DbSkillError(
                "连接 {} 的密码读环境变量 {}，请先: export {}='...'".format(
                    c.get("_name"), env, env))
        return val
    return c.get("password") or ""


class Db:
    def __init__(self, c: dict, typ: str, raw, database, host_dirname: str, mdb=None):
        self.c = c
        self.name = c.get("_name")
        self.type = "postgresql" if typ in ("postgres", "pg") else (
            "sqlite" if typ == "sqlite3" else typ)
        self.raw = raw
        self.database = database
        self.host_dir = host_dirname
        self.mdb = mdb  # mongo: pymongo 的 Database 对象

    def qi(self, name: str) -> str:
        if self.type == "mysql":
            return "`" + str(name).replace("`", "``") + "`"
        return '"' + str(name).replace('"', '""') + '"'

    def qualified(self, table: str, schema: str | None = None) -> str:
        if self.type == "sqlite":
            return self.qi(table)
        if schema and self.type == "postgresql":
            return "{}.{}".format(self.qi(schema), self.qi(table))
        if self.database:
            return "{}.{}".format(self.qi(self.database), self.qi(table))
        return self.qi(table)

    def _cursor(self, stream: bool = False):
        """stream=True 时用不缓冲/服务端游标，大结果集不整包进内存。"""
        if stream and self.type == "mysql":
            try:
                from pymysql.cursors import SSCursor
                return self.raw.cursor(SSCursor)
            except Exception:
                pass
        if stream and self.type == "postgresql":
            try:
                return self.raw.cursor(name="db_skill_stream")
            except Exception:
                pass
        return self.raw.cursor()

    # -- 读
    def q(self, sql: str, args=None, limit: int = 0):
        """limit>0 时最多取 limit 行（流式），0 表示全取。"""
        if self.type == "mongo":
            return self._mongo_read(sql, limit=limit)
        cur = self._cursor(stream=limit > 0)
        try:
            cur.execute(sql, args or ())
            headers = [d[0] for d in (cur.description or [])]
            if limit > 0:
                rows = []
                while len(rows) < limit:
                    batch = cur.fetchmany(min(1000, limit - len(rows)))
                    if not batch:
                        break
                    rows += [list(r) for r in batch]
                return headers, rows
            rows = cur.fetchall() if cur.description else []
            return headers, [list(r) for r in rows]
        finally:
            cur.close()

    def stream(self, sql: str, args=None, batch: int = 1000):
        """流式查询：返回 (headers, 行迭代器)，迭代结束自动关游标。"""
        if self.type == "mongo":
            headers, rows = self._mongo_read(sql)
            return headers, iter(rows)
        cur = self._cursor(stream=True)
        try:
            cur.execute(sql, args or ())
        except Exception:
            cur.close()
            raise
        headers = [d[0] for d in (cur.description or [])]

        def gen():
            try:
                while True:
                    rows = cur.fetchmany(batch)
                    if not rows:
                        break
                    for r in rows:
                        yield list(r)
            finally:
                cur.close()
        return headers, gen()

    def _mongo_read(self, cmd, limit: int = 0):
        if self.mdb is None:
            raise DbSkillError("这个连接没配 database，跑 mongo 命令需要指定库（-d 或 config）")
        if isinstance(cmd, str):
            try:
                cmd = json.loads(cmd)
            except ValueError as e:
                raise DbSkillError("mongo 命令必须是 JSON，"
                                   "如 '{{\"find\":\"user\",\"limit\":5}}'：{}".format(e)) from None
        if not isinstance(cmd, dict) or not cmd:
            raise DbSkillError("mongo 命令必须是 JSON 对象")
        res = self.mdb.command(cmd)
        if isinstance(res, dict) and isinstance(res.get("cursor"), dict):
            cur = res["cursor"]
            docs = list(cur.get("firstBatch") or cur.get("nextBatch") or [])
            cid, ns = cur.get("id") or 0, str(cur.get("ns") or "")
            coll = ns.split(".", 1)[1] if "." in ns else None
            # 翻完 getMore，不让大结果集静默缺数据；limit>0 时够数就停
            while cid and coll and (limit <= 0 or len(docs) < limit):
                res = self.mdb.command({"getMore": cid, "collection": coll})
                cur = res.get("cursor") or {}
                docs += list(cur.get("nextBatch") or [])
                cid = cur.get("id") or 0
            if limit > 0:
                docs = docs[:limit]
            return _docs_to_rows(docs)
        return _mongo_to_rows(res)

    # -- 写
    def exec(self, sql: str, args=None, commit: bool = True):
        if self.type == "mongo":
            n, _ = self.mongo_exec(sql)
            return n
        cur = self.raw.cursor()
        try:
            cur.execute(sql, args or ())
            n = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0
            if commit:
                self.raw.commit()
            return n
        except Exception:
            if commit:
                try:
                    self.raw.rollback()
                except Exception:
                    pass
            raise
        finally:
            cur.close()

    def mongo_exec(self, cmd):
        """执行 mongo 写命令，返回 (影响行数, 完整响应)。"""
        if self.mdb is None:
            raise DbSkillError("这个连接没配 database，跑 mongo 命令需要指定库（-d 或 config）")
        if isinstance(cmd, str):
            try:
                cmd = json.loads(cmd)
            except ValueError as e:
                raise DbSkillError("mongo 命令必须是 JSON：{}".format(e)) from None
        if not isinstance(cmd, dict) or not cmd:
            raise DbSkillError("mongo 命令必须是 JSON 对象")
        res = self.mdb.command(cmd)
        n = 0
        if isinstance(res, dict):
            n = res.get("nModified", res.get("n", 0))
            n = n if isinstance(n, int) else 0
        return n, res

    def one(self, sql: str, args=None):
        _, rows = self.q(sql, args)
        return rows[0][0] if rows and rows[0] else None

    def close(self):
        try:
            self.raw.close()
        except Exception:
            pass


def _docs_to_rows(batch):
    """mongo 文档列表 -> (headers, rows)，表头是全部文档键的并集。"""
    headers, seen = [], set()
    for doc in batch:
        if isinstance(doc, dict):
            for k in doc:
                if k not in seen:
                    seen.add(k)
                    headers.append(k)
    if not headers:
        headers = ["(empty)"]
    rows = []
    for doc in batch:
        d = doc if isinstance(doc, dict) else {"(empty)": doc}
        rows.append([d.get(h) for h in headers])
    return headers, rows


def _mongo_to_rows(res):
    """把 runCommand 的非游标响应统一转成 (headers, rows)。"""
    if not isinstance(res, dict):
        return ["result"], [[res]]
    cur = res.get("cursor")
    if isinstance(cur, dict):
        return _docs_to_rows(cur.get("firstBatch") or cur.get("nextBatch") or [])
    elif "values" in res:
        return ["values"], [[v] for v in res["values"]]
    elif set(res) <= {"n", "ok"}:
        return ["n"], [[res.get("n")]]
    else:
        return ["key", "value"], [[k, res[k]] for k in res]


def connect(name: str | None = None, database: str | None = None,
            cfg: dict | None = None) -> Db:
    if cfg is None:
        cfg = load_config()
    c = get_connection_cfg(cfg, name)
    typ = str(c.get("type") or "").lower()

    if typ in ("sqlite", "sqlite3"):
        import sqlite3
        path = c.get("database")
        if database:
            # sqlite 没有"库"的概念，-d 只能是另一个 .db 文件路径，否则报错而不是静默忽略
            p = Path(os.path.expandvars(str(database))).expanduser()
            if not p.exists():
                raise DbSkillError(
                    "sqlite 的 -d 必须是一个存在的 .db 文件路径: {}".format(database))
            path = str(p)
        if not path:
            raise DbSkillError("连接 {} 缺少 database（sqlite 文件路径）".format(c["_name"]))
        path = str(Path(os.path.expandvars(str(path))).expanduser())
        if not Path(path).exists():
            raise DbSkillError("sqlite 文件不存在: {}".format(path))
        return Db(c, "sqlite", sqlite3.connect(path), Path(path).stem,
                  sanitize(host_dir(c, "sqlite")))

    if typ in ("mysql", "mariadb"):
        pymysql = _import_driver("pymysql", "pip install pymysql")
        raw = pymysql.connect(
            host=c.get("host", "127.0.0.1"),
            port=int(c.get("port", 3306)),
            user=c.get("user", "root"),
            password=_resolve_password(c),
            database=database if database is not None else c.get("database"),
            charset=c.get("charset", "utf8mb4"),
            **(c.get("options") or {}),
        )
        return Db(c, "mysql", raw,
                  database if database is not None else c.get("database"),
                  sanitize(host_dir(c, typ)))

    if typ in ("postgresql", "postgres", "pg"):
        try:
            drv = _import_driver("psycopg2", "")
        except DbSkillError:
            drv = _import_driver("psycopg", "pip install \"psycopg[binary]\"")
        dbname = (database if database is not None else c.get("database")) or "postgres"
        raw = drv.connect(
            host=c.get("host", "127.0.0.1"),
            port=int(c.get("port", 5432)),
            user=c.get("user", "postgres"),
            password=_resolve_password(c),
            dbname=dbname,
            **(c.get("options") or {}),
        )
        return Db(c, "postgresql", raw, dbname, sanitize(host_dir(c, typ)))

    if typ in ("mongo", "mongodb"):
        pymongo = _import_driver("pymongo", "pip install pymongo")
        kwargs = dict(c.get("options") or {})
        user = c.get("user") or None
        if user:
            kwargs.setdefault("authSource", c.get("auth_source") or "admin")
        client = pymongo.MongoClient(
            host=c.get("host", "127.0.0.1"),
            port=int(c.get("port", 27017)),
            username=user,
            password=(_resolve_password(c) or None) if user else None,
            serverSelectionTimeoutMS=int(c.get("timeout_ms", 3000)),
            **kwargs,
        )
        dbname = database if database is not None else c.get("database")
        return Db(c, "mongo", client, dbname, sanitize(host_dir(c, typ)),
                  mdb=client[dbname] if dbname else None)

    raise DbSkillError(
        "不支持的 type: {!r}（支持 mysql / postgresql / sqlite / mongodb）".format(typ))


# ------------------------------------------------------------------ CLI

def _doctor() -> int:
    print("skill 目录: {}".format(SKILL_DIR))
    print("配置文件:   {}".format(config_path()))
    try:
        cfg = load_config()
        print("配置解析:   OK")
    except DbSkillError as e:
        print("配置解析:   失败 -> {}".format(str(e).splitlines()[0]))
        return 1
    ok = True
    for name in cfg["connections"]:
        c = get_connection_cfg(cfg, name)
        typ = str(c.get("type") or "").lower()
        if typ in ("sqlite", "sqlite3"):
            p = Path(str(c.get("database") or "")).expanduser()
            state = "OK" if p.exists() else "文件不存在: {}".format(p)
            ok = ok and p.exists()
        else:
            if typ in ("mysql", "mariadb"):
                mods = ["pymysql"]
            elif typ in ("mongo", "mongodb"):
                mods = ["pymongo"]
            else:
                mods = ["psycopg2", "psycopg"]
            found = [m for m in mods if _has(m)]
            hint = ("pip install " + mods[0]) if len(mods) == 1 \
                else 'pip install "psycopg[binary]"'
            state = "OK ({})".format("/".join(found)) if found else "缺少驱动，装: {}".format(hint)
            ok = ok and bool(found)
        print("  连接 {:<12} type={:<12} {}".format(name, typ, state))
    print("元数据目录: {}".format(metadata_root(cfg)))
    return 0 if ok else 1


def _has(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except ImportError:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="db skill 自检")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--doctor", action="store_true", help="检查配置与驱动")
    g.add_argument("--tmp-dir", action="store_true", help="建一个临时目录并打印")
    args = ap.parse_args()
    if args.tmp_dir:
        print(tempfile.mkdtemp(prefix="db-skill-"))
        return 0
    return _doctor()


if __name__ == "__main__":
    run_cli(main)
