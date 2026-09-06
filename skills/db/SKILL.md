---
name: db
description: 数据库查询与表结构助手。用户要连库查数、看表结构/字段/索引、导出数据、执行 INSERT/UPDATE/DELETE/DDL、或问"这个库有哪些表"时用它；支持 MySQL / PostgreSQL / SQLite / MongoDB。触发词：查一下数据库、表结构、这个表有什么字段、跑个 SQL、导出表数据、连一下 MySQL/Postgres/Mongo。
---

# db

连库查数、看表结构、导出数据、执行写操作。支持 MySQL / PostgreSQL / SQLite / MongoDB。表结构会缓存在 `metadata/` 里，所以看结构不用连库。

## 两步装好

```bash
uv sync                              # 装齐 Python 3.13 + 全部驱动（pymysql / psycopg / pymongo）
cp config.example.json config.json   # 留一个连接、删掉其余的，填上 host/user/database
export MYSQL_PW='...'                # 密码走环境变量，别写进 config.json
```

然后 `uv run scripts/sync.py` 把表结构缓存下来。想确认配置对不对：`uv run scripts/_common.py --doctor`。

所有脚本都用 `uv run` 执行（首次或依赖变更时会自动同步环境，不用手动再跑 `uv sync`）。命令都假设当前目录是 `skills/db/`；在别的目录执行用 `uv run --project <skills/db路径> scripts/q.py ...`。

## 命令（脚本名就是用途）

| 命令 | 作用 |
|---|---|
| `uv run scripts/sync.py` | 同步表结构到 `metadata/`（建表/改表后重跑） |
| `uv run scripts/desc.py` | 列出已缓存的表 |
| `uv run scripts/desc.py user` | 看 user 表结构（读缓存，不连库） |
| `uv run scripts/q.py "select * from user limit 5"` | 查数据（只读，一次一条语句） |
| `uv run scripts/exec.py "update user set status=1 where id=3" --yes` | 写操作（不加 `--yes` 只打印计划） |
| `uv run scripts/export.py user -o ./user.csv` | 导出表 |

- 配了多个连接就加 `-c 连接名`，查别的库加 `-d 库名`（sqlite 的 `-d` 填另一个 .db 文件路径）
- `q.py` 最多打印 200 行（`--max-rows 0` 取消），还能 `-f json|csv|markdown`、`-o 文件`
- `desc.py user --section ddl` 只看某一节；`--path` 只打印文件路径

**MongoDB**：`q.py` / `exec.py` 里写 `db.runCommand` 的 JSON，会 mongosh 就会用：

```bash
uv run scripts/q.py '{"find":"user","filter":{"status":1},"limit":5}'
uv run scripts/exec.py '{"update":"user","updates":[{"q":{"_id":1},"u":{"$set":{"status":1}}}]}' --yes
```

Mongo 没有固定 schema，`sync.py` 按 100 个采样文档推断字段类型（`--infer-rows` 可调）。

**顺序上**：先看 `desc.py` 确认字段，再写 SQL，别猜字段名。

## config.json 字段

必填：`type`（mysql / postgresql / sqlite / mongodb）、`host`、`port`、`user`、`database`（sqlite 填 .db 文件路径）、密码二选一 `password_env`（推荐）或 `password`。Mongo 无认证时 `user` 留空即可。

可选，一般用不到：

| 字段 | 作用 |
|---|---|
| `alias` | 改 `metadata/` 下一级目录名（同一主机多账号时用） |
| `schemas` | PostgreSQL 的 schema 列表，默认 `["public"]` |
| `options` | 透传给驱动，如 `{"sslmode": "require"}` |
| `metadata_dir` | 缓存目录，默认 `metadata` |

## 边界：别把 skill 目录弄脏

`skills/db/` 里只允许这些写入：`metadata/`（只有 `sync.py` 写）、`config.json`（你手工改）、`.venv/` 和 `uv.lock`（只有 `uv` 写）。

- 不在 `skills/db/` 下建临时脚本、测试脚本、导出文件、日志
- `-o` 指向项目目录或 `/tmp`；指到 skill 目录会被 `_common.guard_writable()` 直接拒绝
- 要写一次性脚本，放临时目录，只读引用公共库：

```bash
TMP=$(uv run scripts/_common.py --tmp-dir)      # 或者 mktemp -d
cat > "$TMP/adhoc.py" <<'PY'
import sys
sys.path.insert(0, "<skill>/scripts")            # 只读引用，不产生任何写入
from _common import connect, print_rows
db = connect("local")
try:
    print_rows(*db.q("select status, count(*) from user group by status"))
finally:
    db.close()
PY
uv run "$TMP/adhoc.py"                            # uv run 跑项目外的脚本也用项目环境
```

改代码后跑一遍 `uv run ruff check scripts/`（规则在 `pyproject.toml`）。

## 排错

| 提示 | 怎么办 |
|---|---|
| 缺少配置文件 | `cp config.example.json config.json` |
| 需要环境变量 XXX 提供密码 | `export XXX='...'` |
| 缺少驱动 | `uv sync`（驱动全部声明在 pyproject.toml） |
| 没找到 … 的缓存 | 先跑 `uv run scripts/sync.py` |
| 一次只跑一条语句 | q.py 不支持多语句；多条分开跑，写操作用 exec.py |
| 禁止写入 skill 目录 | `-o` 改到项目目录或 `/tmp` |
