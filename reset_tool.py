"""绳网 InterKnot — 数据还原工具

把服务端一键还原到「无任何数据」的初始状态：
  - 删除主数据库（data.db 及其 journal/wal/shm 附属文件）
  - 删除登录签名密钥（secrets.env，登录态全部失效，下次启动自动重新生成）
  - 删除管理员安装密钥（setup-admin-key.txt，下次启动自动重新生成）
  - 清空上传目录（public/uploads）内的全部内容
  - 可选：重置考试参数（data/exam_config.json）

安全设计：
  - 所有操作严格限定在服务端根目录内（须校验 package.json 等目录标志，防止拷到别处误跑）
  - 精确白名单删除，data.json / 考题配置 / 备份文件 / 程序本体一概不碰
  - 执行前双保险检测：服务端端口探测 + 数据库文件占用自测
  - 删除前可选打包 zip 备份（默认勾选，备份失败则中止删除）
  - 逐项独立错误处理，任何一项失败不影响其余项，最后汇总报告
"""
import os
import sys
import socket
import shutil
import zipfile
import threading
import traceback
from datetime import datetime
from pathlib import Path

import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext

APP_TITLE = "数据还原工具 - 绳网 InterKnot"
CONFIRM_WORD = "RESET"
DEFAULT_PORT = 1337
BACKUP_PREFIX = "reset-backup-"

# ── 精确白名单：仅这些路径会被删除（相对服务端根目录） ──────────────
DB_FILES = [
    "data/data.db",
    "data/data.db-journal",
    "data/data.db-wal",
    "data/data.db-shm",
]
SESSION_FILES = [
    "data/secrets.env",
    "data/setup-admin-key.txt",
]
UPLOADS_DIR = "public/uploads"
EXAM_CONFIG = "data/exam_config.json"

# 永不触碰的文件（防御性声明，即便落在上述目录内也不删）
NEVER_TOUCH = {"data/data.json", "data/reset-backup-", "public/web", "public/admin"}


def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).parent


def _inside_base(base: Path, target: Path) -> bool:
    """realpath 防逃逸：目标必须真的位于服务端根目录内。"""
    try:
        rb = os.path.realpath(str(base))
        rt = os.path.realpath(str(target))
        return os.path.commonpath([rb, rt]) == rb
    except (ValueError, OSError):
        return False


def validate_base_dir(base: Path):
    """确认当前目录确实是 InterKnot 服务端目录（防止 exe 被拷到别处误跑）。"""
    problems = []
    if not (base / "package.json").is_file():
        problems.append("缺少 package.json")
    if not (base / "data" / "data.json").is_file():
        problems.append("缺少 data/data.json")
    if not (base / "node_modules" / "@strapi").is_dir() and not (base / "src" / "api").is_dir():
        problems.append("缺少 node_modules/@strapi 或 src/api")
    if problems:
        return False, "；".join(problems)
    return True, ""


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def path_size(p: Path) -> int:
    try:
        if p.is_file():
            return p.stat().st_size
        if p.is_dir():
            total = 0
            for root, _dirs, files in os.walk(p):
                for f in files:
                    try:
                        total += (Path(root) / f).stat().st_size
                    except OSError:
                        pass
            return total
    except OSError:
        pass
    return 0


def scan_reset_items(base: Path, reset_exam: bool):
    """扫描实际存在的待清理项。返回 [{rel, path, size, kind}]，kind: file|dir。"""
    items = []
    for rel in DB_FILES + SESSION_FILES:
        p = base / rel
        if p.is_file():
            items.append({"rel": rel, "path": p, "size": p.stat().st_size, "kind": "file"})
    up = base / UPLOADS_DIR
    if up.is_dir():
        items.append({
            "rel": UPLOADS_DIR + "/（全部内容）",
            "path": up,
            "size": path_size(up),
            "kind": "dir",
        })
    if reset_exam:
        p = base / EXAM_CONFIG
        if p.is_file():
            items.append({"rel": EXAM_CONFIG, "path": p, "size": p.stat().st_size, "kind": "file"})
    return items


def check_port_busy(port: int, timeout: float = 1.0):
    """端口有服务监听 → (True, 说明)。用于阻止在服务端运行时删库。"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True, f"端口 {port} 有服务在监听（服务端可能仍在运行）"
    except (ConnectionRefusedError, socket.timeout, OSError):
        return False, f"端口 {port} 空闲"
    except ValueError:
        return True, f"端口号 {port} 无效"


def check_db_not_locked(base: Path):
    """data.db 占用自测：rename 到临时名再改回。

    SQLite 打开的文件未共享 DELETE 权限，重命名会失败——
    以此检测服务端 / 考题编辑器是否仍占用数据库。"""
    db = base / "data" / "data.db"
    if not db.is_file():
        return True, "data.db 不存在"
    tmp = db.with_name("data.db.__locktest__")
    try:
        os.rename(db, tmp)
    except OSError as e:
        return False, f"data.db 被占用（{e.strerror or e}）——请先停止服务端并关闭考题编辑器"
    # rename 成功，立即还原
    try:
        os.rename(tmp, db)
    except OSError:
        # 极端情况：还原失败，用拷贝兜底避免锁测试留下损坏状态
        try:
            shutil.copyfile(tmp, db)
            tmp.unlink()
        except OSError:
            pass
    return True, "未被占用"


def _rmtree_ro_handler(func, path, exc_info):
    """Windows 只读文件导致的 rmtree 失败：去掉只读位后重试一次。"""
    import stat
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except Exception:
        raise


def create_backup(base: Path, items, zip_path: Path, log):
    """把待删内容打包为 zip（保留相对路径）。失败返回 False——宁可不清也不丢数据。"""
    log(f"[backup] 正在创建备份: {zip_path.name}")
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for item in items:
                p: Path = item["path"]
                if item["kind"] == "file":
                    zf.write(p, item["rel"].replace("/", os.sep))
                    log(f"[backup]   + {item['rel']} ({human_size(item['size'])})")
                else:
                    # uploads 目录：逐文件收入 zip，保留目录内相对结构
                    up = base / UPLOADS_DIR
                    for root, _dirs, files in os.walk(up):
                        for f in files:
                            fp = Path(root) / f
                            try:
                                arc = UPLOADS_DIR + "/" + str(fp.relative_to(up)).replace("\\", "/")
                                zf.write(fp, arc)
                            except OSError as e:
                                log(f"[backup]   ! 跳过无法读取的文件 {fp.name}: {e}")
                    log(f"[backup]   + {UPLOADS_DIR}/（全部内容）")
        size = zip_path.stat().st_size
        log(f"[backup] 备份完成 ({human_size(size)})")
        return True, ""
    except Exception as e:
        log(f"[backup] 备份失败: {e}")
        try:
            zip_path.unlink()
        except OSError:
            pass
        return False, str(e)


def _remove_file(p: Path, rel: str, results, log):
    try:
        p.unlink()
        results.append((rel, True, "已删除"))
        log(f"[delete] ✓ {rel}")
    except PermissionError:
        results.append((rel, False, "文件被占用——请先停止服务端并关闭考题编辑器"))
        log(f"[delete] ✗ {rel} 被占用")
    except FileNotFoundError:
        results.append((rel, True, "不存在，跳过"))
    except Exception as e:
        results.append((rel, False, str(e)))
        log(f"[delete] ✗ {rel}: {e}")


def _clear_dir_contents(d: Path, results, log):
    """清空目录内全部内容，保留目录本身。"""
    import stat
    if not d.is_dir():
        results.append((UPLOADS_DIR + "/", True, "目录不存在，跳过"))
        log(f"[delete] - {UPLOADS_DIR}/ 不存在，跳过")
        return
    ok, failed, total = 0, 0, 0
    for entry in list(d.iterdir()):
        total += 1
        try:
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry, onerror=_rmtree_ro_handler)
            else:
                try:
                    entry.unlink()
                except PermissionError:
                    # 只读位文件：去掉只读属性后重试一次；
                    # 仍失败（真被占用）则归类为占用错误。
                    try:
                        os.chmod(entry, stat.S_IWRITE)
                        entry.unlink()
                    except PermissionError:
                        raise
            ok += 1
        except PermissionError:
            failed += 1
            results.append((f"{UPLOADS_DIR}/{entry.name}", False, "文件被占用——请先停止服务端"))
            log(f"[delete] ✗ {UPLOADS_DIR}/{entry.name} 被占用")
        except Exception as e:
            failed += 1
            results.append((f"{UPLOADS_DIR}/{entry.name}", False, str(e)))
            log(f"[delete] ✗ {UPLOADS_DIR}/{entry.name}: {e}")
    if failed == 0:
        results.append((f"{UPLOADS_DIR}/（共 {total} 项）", True, "已清空，保留目录"))
        log(f"[delete] ✓ {UPLOADS_DIR}/ 已清空（{total} 项），保留目录本身")
    else:
        results.append((f"{UPLOADS_DIR}/", False, f"{failed}/{total} 项失败"))


def perform_reset(base: Path, port: int, backup: bool, reset_exam: bool, log) -> tuple:
    """执行还原主流程。返回 (成功与否, 结果明细列表 [(路径, 成功, 说明)])。"""
    results = []

    # 0. 目录合法性（防误删的第一道锚）
    ok, why = validate_base_dir(base)
    if not ok:
        results.append(("目录校验", False, f"当前目录不是有效的服务端目录：{why}"))
        return False, results

    # 1. 服务端运行检测（双保险）
    busy, why = check_port_busy(port)
    if busy:
        results.append(("服务端运行检测", False, why + "——请先停止服务端"))
        return False, results
    log(f"[check] {why}")

    # 2. 扫描
    items = scan_reset_items(base, reset_exam)
    if not items:
        log("[reset] 未发现任何可清理的数据，当前已是干净状态。")
        results.append(("扫描", True, "没有需要清理的数据"))
        return True, results

    for it in items:
        # 路径逃逸防御：任何待删路径都必须位于根目录内
        if not _inside_base(base, it["path"]):
            results.append((it["rel"], False, "路径越界，已拒绝删除"))
            log(f"[reset] ✗ 路径越界，拒绝删除: {it['path']}")
            return False, results

    # 3. 数据库占用自测
    locked, why = check_db_not_locked(base)
    if not locked:
        results.append(("数据库占用检测", False, why))
        return False, results
    log(f"[check] {why}")

    # 4. 备份（失败则中止，宁可不清也不丢数据）
    if backup:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        zip_path = base / "data" / f"{BACKUP_PREFIX}{stamp}.zip"
        ok, err = create_backup(base, items, zip_path, log)
        if not ok:
            results.append(("备份", False, err + "——已中止删除，数据未受影响"))
            return False, results
    else:
        log("[reset] 已跳过备份（用户选择）")

    # 5. 逐项删除（白名单精确匹配 + 每项独立错误处理）
    log("[reset] 开始删除……")
    for rel in DB_FILES + SESSION_FILES:
        _remove_file(base / rel, rel, results, log)
    _clear_dir_contents(base / UPLOADS_DIR, results, log)
    if reset_exam:
        _remove_file(base / EXAM_CONFIG, EXAM_CONFIG, results, log)

    ok = all(succ for _, succ, _ in results)
    return ok, results


# ════════════════════════ GUI ════════════════════════

class ResetApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title(APP_TITLE)
        self.root.geometry("680x620")
        self.root.minsize(600, 540)
        self.root.configure(bg="#1a1a2e")
        self.base = get_base_dir()
        self.busy = False

        self._style()
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.after(200, self.refresh_scan)

    def _style(self):
        s = ttk.Style()
        s.theme_use("clam")
        s.configure("TFrame", background="#1a1a2e")
        s.configure("TLabel", background="#1a1a2e", foreground="#e0e0e0",
                    font=("Microsoft YaHei UI", 10))
        s.configure("Title.TLabel", background="#1a1a2e", foreground="#ff6b6b",
                    font=("Microsoft YaHei UI", 15, "bold"))
        s.configure("Muted.TLabel", background="#1a1a2e", foreground="#888",
                    font=("Microsoft YaHei UI", 9))
        s.configure("Status.TLabel", background="#1a1a2e", font=("Microsoft YaHei UI", 10))
        s.configure("TButton", font=("Microsoft YaHei UI", 10))
        s.configure("TCheckbutton", background="#1a1a2e", foreground="#e0e0e0",
                    font=("Microsoft YaHei UI", 10))

    def _build_ui(self):
        main = ttk.Frame(self.root, padding="16")
        main.pack(fill=tk.BOTH, expand=True)

        ttk.Label(main, text="一键还原（清空全部数据）", style="Title.TLabel").pack(anchor=tk.CENTER)
        ttk.Label(main, text="删除数据库 / 登录密钥 / 上传文件，把服务端恢复到全新状态",
                  style="Muted.TLabel").pack(anchor=tk.CENTER, pady=(0, 8))

        # 目录校验状态
        self.base_ok, self.base_why = validate_base_dir(self.base)
        status_text = f"服务端目录: {self.base}" if self.base_ok else f"✗ 目录校验失败: {self.base_why}"
        self.dir_status = ttk.Label(main, text=status_text, style="Status.TLabel",
                                    foreground="#4ecdc4" if self.base_ok else "#ff6b6b")
        self.dir_status.pack(anchor=tk.W, pady=(0, 6))

        # 端口 + 重新扫描
        row = ttk.Frame(main); row.pack(fill=tk.X, pady=(0, 4))
        ttk.Label(row, text="服务端端口:").pack(side=tk.LEFT, padx=(0, 4))
        self.port_var = tk.StringVar(value=str(DEFAULT_PORT))
        port_entry = ttk.Entry(row, textvariable=self.port_var, width=7, font=("Consolas", 10))
        port_entry.pack(side=tk.LEFT)
        ttk.Label(row, text="（若改过服务端口请填写实际端口）", style="Muted.TLabel").pack(side=tk.LEFT, padx=(4, 8))
        self.scan_btn = ttk.Button(row, text="↻ 重新扫描", command=self.refresh_scan)
        self.scan_btn.pack(side=tk.LEFT)

        # 扫描清单
        ttk.Label(main, text="将要删除的内容（白名单精确匹配，其余文件一律不碰）：").pack(anchor=tk.W, pady=(8, 2))
        self.list_text = scrolledtext.ScrolledText(main, height=8, font=("Consolas", 9),
                                                   bg="#0d0d1a", fg="#a0a0b0", relief=tk.FLAT)
        self.list_text.pack(fill=tk.X)
        self.list_text.configure(state=tk.DISABLED)

        # 选项
        opt = ttk.Frame(main); opt.pack(fill=tk.X, pady=(6, 2))
        self.backup_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(opt, text="删除前备份为 zip（强烈建议，备份保存在 data\\ 目录）",
                        variable=self.backup_var).pack(side=tk.LEFT)
        self.exam_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(opt, text="同时重置考试参数配置", variable=self.exam_var).pack(side=tk.LEFT, padx=(16, 0))

        # 确认词 + 执行
        row2 = ttk.Frame(main); row2.pack(fill=tk.X, pady=(6, 0))
        ttk.Label(row2, text=f'输入 {CONFIRM_WORD} 以解锁按钮:').pack(side=tk.LEFT, padx=(0, 6))
        self.confirm_var = tk.StringVar()
        self.confirm_entry = ttk.Entry(row2, textvariable=self.confirm_var, width=10,
                                       font=("Consolas", 10))
        self.confirm_entry.pack(side=tk.LEFT)
        self.confirm_var.trace_add("write", lambda *_: self._update_button())
        self.exec_btn = ttk.Button(row2, text="▶ 执行还原", command=self._on_execute, state=tk.DISABLED)
        self.exec_btn.pack(side=tk.LEFT, padx=(12, 0))
        ttk.Label(row2, text="执行后需重启服务端并重新设置管理员", style="Muted.TLabel").pack(side=tk.LEFT, padx=(10, 0))

        # 日志
        ttk.Label(main, text="执行日志:").pack(anchor=tk.W, pady=(8, 2))
        self.log_text = scrolledtext.ScrolledText(main, font=("Consolas", 9),
                                                  bg="#0d0d1a", fg="#a0a0b0", relief=tk.FLAT, height=9)
        self.log_text.pack(fill=tk.BOTH, expand=True)
        self.log_text.configure(state=tk.DISABLED)

    # ── 日志 ──
    def log(self, text):
        def _append():
            self.log_text.configure(state=tk.NORMAL)
            self.log_text.insert(tk.END, text + "\n")
            self.log_text.see(tk.END)
            self.log_text.configure(state=tk.DISABLED)
        self.root.after(0, _append)

    # ── 扫描 ──
    def refresh_scan(self):
        if self.busy:
            return
        self.base_ok, self.base_why = validate_base_dir(self.base)
        self.dir_status.configure(
            text=(f"服务端目录: {self.base}" if self.base_ok else f"✗ 目录校验失败: {self.base_why}"),
            foreground="#4ecdc4" if self.base_ok else "#ff6b6b")

        lines = []
        if not self.base_ok:
            lines.append(f"✗ 目录校验失败：{self.base_why}")
            lines.append("  请把本程序放在服务端根目录后再运行。")
        else:
            reset_exam = self.exam_var.get()
            items = scan_reset_items(self.base, reset_exam)
            if not items:
                lines.append("✓ 当前已是干净状态，没有需要清理的数据。")
            total = 0
            for it in items:
                total += it["size"]
                lines.append(f"  [将删除] {it['rel']}  ({human_size(it['size'])})")
            lines.append(f"  合计: {human_size(total)}")
            keep = ["data/data.json（程序资源）", "data/exam_config.json（考试参数，未勾选重置）",
                    "data/reset-backup-*.zip（历史备份）"]
            lines.append("  保留不删: " + "；".join(keep if not reset_exam else keep[:1]))
        self.list_text.configure(state=tk.NORMAL)
        self.list_text.delete("1.0", tk.END)
        self.list_text.insert(tk.END, "\n".join(lines) + "\n")
        self.list_text.configure(state=tk.DISABLED)
        self._update_button()

    def _update_button(self):
        ok = (self.confirm_var.get().strip() == CONFIRM_WORD
              and self.base_ok and not self.busy)
        self.exec_btn.configure(state=tk.NORMAL if ok else tk.DISABLED)

    # ── 执行 ──
    def _on_execute(self):
        if self.busy or not self.base_ok:
            return
        try:
            port = int(self.port_var.get().strip())
            if not (1 <= port <= 65535):
                raise ValueError
        except ValueError:
            messagebox.showerror("错误", "端口号无效（1-65535）")
            return

        reset_exam = self.exam_var.get()
        items = scan_reset_items(self.base, reset_exam)
        if not items:
            messagebox.showinfo("提示", "当前已是干净状态，没有需要清理的数据。")
            return
        summary = "\n".join(f"  · {it['rel']}  ({human_size(it['size'])})" for it in items)
        backup_txt = "会先备份为 zip" if self.backup_var.get() else "【不会备份，直接删除】"
        if not messagebox.askyesno(
                "最终确认",
                "即将删除以下全部内容（" + backup_txt + "）：\n\n" + summary +
                f"\n\n目录: {self.base}\n\n确定继续吗？"):
            return

        self.busy = True
        self.exec_btn.configure(state=tk.DISABLED)
        self.scan_btn.configure(state=tk.DISABLED)
        threading.Thread(target=self._do_execute, args=(port, reset_exam), daemon=True).start()

    def _do_execute(self, port, reset_exam):
        try:
            backup = self.backup_var.get()
            log = self.log

            # 执行前复查（扫描后状态可能变化）
            busy, why = check_port_busy(port)
            if busy:
                self.log(f"[abort] {why}——已中止")
                messagebox.showerror("已中止", why + "\n请先停止服务端再执行还原。")
                return
            ok, why = check_db_not_locked(self.base)
            if not ok:
                self.log(f"[abort] {why}")
                messagebox.showerror("已中止", why)
                return

            ok, results = perform_reset(self.base, port, backup, reset_exam, log)

            ok_count = sum(1 for _, succ, _ in results if succ)
            all_ok = ok
            summary = "还原完成" if all_ok else "还原完成（部分失败）"
            detail = "\n".join(
                f"  {'✓' if succ else '✗'} {name}：{msg}" for name, succ, msg in results
            )
            self.log(f"[done] {summary}（成功 {ok_count}/{len(results)} 项）")
            if all_ok:
                messagebox.showinfo(
                    "还原完成",
                    "已恢复到全新状态。\n\n下一步：\n"
                    "  1. 启动服务端（会自动重新生成密钥与空数据库）\n"
                    "  2. 访问 /register 重新注册账号\n"
                    "  3. 在 /admin 用 data\\setup-admin-key.txt 中的新密钥设置管理员")
            else:
                messagebox.showwarning(
                    summary, "部分项目删除失败：\n\n" + detail +
                    "\n\n常见原因：服务端或考题编辑器仍在运行。请全部停止后重试。")
        except Exception:
            err = traceback.format_exc()
            self.log("[fatal] " + err)
            messagebox.showerror("发生异常", "还原过程中出现未预期的异常，详见日志窗口。")
        finally:
            self.busy = False
            self.root.after(0, lambda: (self.exec_btn.configure(state=tk.NORMAL),
                                        self.scan_btn.configure(state=tk.NORMAL),
                                        self.refresh_scan()))

    def _on_close(self):
        if self.busy:
            if not messagebox.askyesno("确认", "还原正在执行中，确定退出吗？"):
                return
        self.root.destroy()


def main():
    if sys.platform == "win32":
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
        # 数据删除工具默认给控制台窗口，便于查看与截图留证；GUI 同窗口运行
    app = ResetApp()
    app.root.mainloop()


if __name__ == "__main__":
    main()
