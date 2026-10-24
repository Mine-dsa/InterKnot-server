"""reset_tool 核心逻辑自动化演练：覆盖全部安全机制。"""
import os
import sys
import socket
import shutil
import sqlite3
import zipfile
import threading
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reset_tool as rt

WORK = Path(__file__).parent
TEST_BASE = WORK / "__reset-test-env__"
FAILS = []


def need(tag, ok):
    print(f"[{tag}] {'OK' if ok else '✗ FAIL'}")
    if not ok:
        FAILS.append(tag)


import stat


def _force_rmtree(p):
    """测试清理用：处理 Windows 只读文件。"""
    def _onerr(func, path, exc_info):
        try:
            os.chmod(path, stat.S_IWRITE)
            func(path)
        except Exception:
            pass
    shutil.rmtree(p, onerror=_onerr)


def make_fake_env(with_exam=True):
    """造一套完整的假服务端数据环境。"""
    if TEST_BASE.exists():
        _force_rmtree(TEST_BASE)
    d = TEST_BASE / "data"; d.mkdir(parents=True)
    up_root = TEST_BASE / "public" / "uploads"
    up = up_root / "2026" / "08"; up.mkdir(parents=True)
    (TEST_BASE / "package.json").write_text('{"name":"inter-knot"}', encoding="utf-8")
    (TEST_BASE / "src" / "api").mkdir(parents=True)  # 目录标志之二（校验三选二）
    (d / "data.json").write_text("[]", encoding="utf-8")
    # 真 SQLite 库（带表和数据）
    c = sqlite3.connect(d / "data.db")
    c.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    c.execute("INSERT INTO t VALUES (1, 'hello')")
    c.commit(); c.close()
    (d / "secrets.env").write_text("APP_KEYS=abc\n", encoding="utf-8")
    (d / "setup-admin-key.txt").write_text("SETUP_ADMIN_KEY=abcd1234\n", encoding="utf-8")
    if with_exam:
        (d / "exam_config.json").write_text('{"passScorePercent":90}', encoding="utf-8")
    (up_root / "img1.png").write_bytes(b"\x89PNG fake" * 100)
    (up / "img2.png").write_bytes(b"\x89PNG fake2" * 100)
    (TEST_BASE / "data" / "reset-backup-20200101-000000.zip").write_bytes(b"old backup")


def main():
    logs = []
    log = lambda t: logs.append(t)

    # ── T1 目录校验：空目录必须被拒 ──
    empty = WORK / "__reset-test-empty__"
    empty.mkdir(exist_ok=True)
    ok, why = rt.validate_base_dir(empty)
    need("T1a 非服务端目录被拒", not ok)
    shutil.rmtree(empty)

    # ── T2 正常还原（备份 + 不重置考试配置） ──
    make_fake_env()
    db_before_size = (TEST_BASE / "data" / "data.db").stat().st_size
    ok, results = rt.perform_reset(TEST_BASE, 13399, backup=True, reset_exam=False, log=log)
    need("T2a 还原成功", ok)
    need("T2b 数据库已删", not (TEST_BASE / "data" / "data.db").exists())
    need("T2c secrets.env 已删", not (TEST_BASE / "data" / "secrets.env").exists())
    need("T2d setup-admin-key 已删", not (TEST_BASE / "data" / "setup-admin-key.txt").exists())
    up = TEST_BASE / "public" / "uploads"
    leftover = list(up.iterdir()) if up.is_dir() else None
    need("T2e uploads 已清空且目录保留", up.is_dir() and leftover == [])
    need("T2f data.json 保护完好", (TEST_BASE / "data" / "data.json").read_text() == "[]")
    need("T2g exam_config 保留（未勾选）", (TEST_BASE / "data" / "exam_config.json").exists())
    need("T2h 旧备份 zip 未被碰", (TEST_BASE / "data" / "reset-backup-20200101-000000.zip").exists())
    backups = [b for b in (TEST_BASE / "data").glob("reset-backup-*.zip")
               if b.name != "reset-backup-20200101-000000.zip"]
    need("T2i 生成 1 个新备份", len(backups) == 1)
    if backups:
        with zipfile.ZipFile(backups[0]) as zf:
            names = zf.namelist()
        has_db = any(n.endswith("data.db") for n in names)
        has_up = any("uploads" in n and "img1.png" in n for n in names)
        has_sec = any(n.endswith("secrets.env") for n in names)
        need("T2j 备份含数据库", has_db)
        need("T2k 备份含上传文件", has_up)
        need("T2l 备份含密钥", has_sec)
    # 备份可解出可用数据库
    if backups:
        with zipfile.ZipFile(backups[0]) as zf:
            zf.extract("data/data.db", TEST_BASE / "__verify__")
        c = sqlite3.connect(TEST_BASE / "__verify__" / "data" / "data.db")
        row = c.execute("SELECT v FROM t WHERE id=1").fetchone()
        c.close()
        need("T2m 备份库可读且数据完整", row and row[0] == "hello")
        shutil.rmtree(TEST_BASE / "__verify__")

    # ── T3 已干净状态 ──
    ok, results = rt.perform_reset(TEST_BASE, 13399, backup=False, reset_exam=False, log=log)
    need("T3 已干净时返回成功且无事发生", ok)

    # ── T4 端口占用 → 拒绝且不删任何东西 ──
    make_fake_env()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 13398)); sock.listen(1)
    ok, results = rt.perform_reset(TEST_BASE, 13398, backup=False, reset_exam=False, log=log)
    need("T4a 端口占用被拒", not ok)
    need("T4b 数据未被删", (TEST_BASE / "data" / "data.db").exists())
    sock.close()

    # ── T5 数据库被占用（模拟服务端/编辑器持有连接）→ 拒绝且不删 ──
    make_fake_env()
    conn = sqlite3.connect(TEST_BASE / "data" / "data.db")
    conn.execute("SELECT 1")
    ok, results = rt.perform_reset(TEST_BASE, 13399, backup=False, reset_exam=False, log=log)
    conn.close()
    need("T5a db 占用被拒", not ok)
    need("T5b 数据未被删", (TEST_BASE / "data" / "data.db").exists())
    need("T5c secrets 未删", (TEST_BASE / "data" / "secrets.env").exists())

    # ── T6 重置考试配置（勾选） ──
    make_fake_env()
    ok, results = rt.perform_reset(TEST_BASE, 13399, backup=True, reset_exam=True, log=log)
    need("T6a 还原成功", ok)
    need("T6b exam_config 已删", not (TEST_BASE / "data" / "exam_config.json").exists())

    # ── T7 只读文件（Windows 常见坑）也能删 ──
    make_fake_env()
    stubborn = TEST_BASE / "public" / "uploads" / "readonly.png"
    stubborn.write_bytes(b"x" * 10)
    os.chmod(stubborn, 0o444)
    ok, results = rt.perform_reset(TEST_BASE, 13399, backup=False, reset_exam=False, log=log)
    need("T7 只读文件场景还原成功", ok and not stubborn.exists())

    # ── T8 无备份模式 ──
    make_fake_env()
    ok, results = rt.perform_reset(TEST_BASE, 13399, backup=False, reset_exam=False, log=log)
    new_backups = [b for b in (TEST_BASE / "data").glob("reset-backup-*.zip")
                   if b.name != "reset-backup-20200101-000000.zip"]
    need("T8 无备份模式不产生新 zip", ok and len(new_backups) == 0)

    # ── T9 真实服务端目录演练（WORK 本体——有 data.json 无 data.db，应安全无事） ──
    ok, results = rt.perform_reset(WORK, 13399, backup=False, reset_exam=False, log=log)
    need("T9 真实目录（已干净）安全通过", ok)
    need("T9b 真实 data.json 完好", (WORK / "data" / "data.json").exists())

    # 清理测试环境
    shutil.rmtree(TEST_BASE, ignore_errors=True)

    print()
    if FAILS:
        print(f"=== {len(FAILS)} 项失败: {', '.join(FAILS)} ===")
        sys.exit(1)
    print("=== 核心逻辑全部通过 ===")


if __name__ == "__main__":
    main()
