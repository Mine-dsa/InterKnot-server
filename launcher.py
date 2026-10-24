import sys
import os
import subprocess
import threading
import time
import webbrowser
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
from pathlib import Path


def get_base_dir():
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).parent
    return Path(__file__).parent


class InterKnotLauncher:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("绳网 InterKnot 服务端启动器")
        self.root.geometry("680x560")
        self.root.resizable(True, True)
        self.root.minsize(520, 440)
        self.root.configure(bg="#1a1a2e")

        self.process = None
        self.reader_thread = None
        self.running = False
        self.port = tk.StringVar(value="1337")
        self.base_dir = get_base_dir()
        self.server_dir = self.base_dir
        self.output_lock = threading.Lock()
        self.link_container = None
        self.server_ready = False

        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TFrame", background="#1a1a2e")
        style.configure("TLabel", background="#1a1a2e", foreground="#e0e0e0", font=("Microsoft YaHei UI", 10))
        style.configure("Title.TLabel", background="#1a1a2e", foreground="#ff6b6b",
                        font=("Microsoft YaHei UI", 16, "bold"))
        style.configure("Link.TLabel", background="#1a1a2e", foreground="#4ecdc4",
                        font=("Microsoft YaHei UI", 10, "underline"))
        style.configure("Status.TLabel", background="#1a1a2e", font=("Microsoft YaHei UI", 10))
        style.configure("TButton", font=("Microsoft YaHei UI", 10))

        self.build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def build_ui(self):
        main = ttk.Frame(self.root, padding="20")
        main.pack(fill=tk.BOTH, expand=True)

        ttk.Label(main, text="绳网 InterKnot 服务端", style="Title.TLabel").pack(anchor=tk.CENTER)
        desc = ttk.Label(main, text="本地一键运行的绳网平台服务端", font=("Microsoft YaHei UI", 9))
        desc.pack(anchor=tk.CENTER, pady=(0, 15))

        config_frame = ttk.Frame(main)
        config_frame.pack(fill=tk.X, pady=(0, 10))

        ttk.Label(config_frame, text="服务端端口:").pack(side=tk.LEFT, padx=(0, 8))
        port_entry = ttk.Entry(config_frame, textvariable=self.port, width=10, font=("Consolas", 11))
        port_entry.pack(side=tk.LEFT)
        port_entry.focus()
        port_entry.select_range(0, tk.END)
        port_entry.bind("<Return>", lambda e: self.start_server())

        ttk.Label(config_frame, text="  (1024-65535, 默认 1337)", font=("Microsoft YaHei UI", 9),
                  foreground="#888").pack(side=tk.LEFT, padx=(4, 0))

        btn_frame = ttk.Frame(main)
        btn_frame.pack(fill=tk.X, pady=(0, 10))

        self.start_btn = ttk.Button(btn_frame, text="▶ 启动服务端", command=self.start_server)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 10))

        self.stop_btn = ttk.Button(btn_frame, text="■ 停止服务端", command=self.stop_server, state=tk.DISABLED)
        self.stop_btn.pack(side=tk.LEFT)

        status_frame = ttk.Frame(main)
        status_frame.pack(fill=tk.X, pady=(0, 5))

        self.status_label = ttk.Label(status_frame, text="● 未启动", style="Status.TLabel", foreground="#888")
        self.status_label.pack(anchor=tk.CENTER)

        self.link_container = ttk.Frame(main)
        self.link_container.pack(fill=tk.X, pady=(5, 10))
        ttk.Label(self.link_container, text="启动服务器后将在此显示访问地址...", foreground="#555",
                  font=("Microsoft YaHei UI", 9)).pack(anchor=tk.CENTER)

        output_frame = ttk.Frame(main)
        output_frame.pack(fill=tk.BOTH, expand=True)

        ttk.Label(output_frame, text="服务端日志:", font=("Microsoft YaHei UI", 9, "bold"),
                  foreground="#888").pack(anchor=tk.W, pady=(0, 3))

        self.output = scrolledtext.ScrolledText(
            output_frame, wrap=tk.WORD, font=("Consolas", 9),
            bg="#0d0d1a", fg="#a0a0b0", insertbackground="#a0a0b0",
            relief=tk.FLAT, borderwidth=0, padx=8, pady=8, height=12
        )
        self.output.pack(fill=tk.BOTH, expand=True)
        self.output.configure(state=tk.DISABLED)

        copy_btn = ttk.Button(main, text="复制日志", command=self.copy_log)
        copy_btn.pack(side=tk.RIGHT, pady=(5, 0))

    def log(self, text):
        with self.output_lock:
            self.output.configure(state=tk.NORMAL)
            self.output.insert(tk.END, text + "\n")
            self.output.see(tk.END)
            self.output.configure(state=tk.DISABLED)

    def copy_log(self):
        text = self.output.get("1.0", tk.END)
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.log("[GUI] 日志已复制到剪贴板")

    def update_links(self, port):
        for widget in self.link_container.winfo_children():
            widget.destroy()

        web_url = f"http://localhost:{port}"
        admin_url = f"http://localhost:{port}/admin"

        row = ttk.Frame(self.link_container)
        row.pack(anchor=tk.CENTER)

        ttk.Label(row, text="访问地址: ", font=("Microsoft YaHei UI", 10, "bold")).pack(side=tk.LEFT)
        web_btn = ttk.Label(row, text=web_url, style="Link.TLabel", cursor="hand2")
        web_btn.pack(side=tk.LEFT)
        web_btn.bind("<Button-1>", lambda e: webbrowser.open(web_url))

        ttk.Label(row, text="    |    管理后台: ", font=("Microsoft YaHei UI", 10, "bold")).pack(side=tk.LEFT)
        admin_btn = ttk.Label(row, text=admin_url, style="Link.TLabel", cursor="hand2")
        admin_btn.pack(side=tk.LEFT)
        admin_btn.bind("<Button-1>", lambda e: webbrowser.open(admin_url))

        row2 = ttk.Frame(self.link_container)
        row2.pack(anchor=tk.CENTER, pady=(4, 0))
        ttk.Label(row2, text="首次使用请访问管理后台注册管理员账号",
                  foreground="#888", font=("Microsoft YaHei UI", 9)).pack()

    def validate_port(self, port_str):
        try:
            port = int(port_str)
            return 1024 <= port <= 65535
        except ValueError:
            return False

    def start_server(self):
        port_str = self.port.get().strip()
        if not self.validate_port(port_str):
            messagebox.showerror("错误", "端口号必须在 1024-65535 之间")
            return

        port = int(port_str)

        self.log("─" * 55)
        self.log(f"[GUI] 正在启动服务端... 端口: {port}")
        self.log(f"[GUI] 数据存储目录: {self.server_dir / 'data'}")
        self.log("─" * 55)

        self.start_btn.configure(state=tk.DISABLED)
        self.stop_btn.configure(state=tk.NORMAL)
        self.status_label.configure(text="● 启动中...", foreground="#f0c040")

        for widget in self.link_container.winfo_children():
            widget.destroy()
        ttk.Label(self.link_container, text="正在启动，请稍候...", foreground="#f0c040",
                  font=("Microsoft YaHei UI", 10)).pack(anchor=tk.CENTER)

        env = os.environ.copy()

        env["HOST"] = "0.0.0.0"
        env["PORT"] = str(port)
        env["DATABASE_CLIENT"] = "sqlite"
        env["DATABASE_FILENAME"] = "data/data.db"

        env.pop("REDIS_URL", None)
        env.pop("MEILISEARCH_HOST", None)
        env.pop("MEILISEARCH_API_KEY", None)
        env.pop("QINIU_S3_ENDPOINT", None)
        env.pop("QINIU_ACCESS_KEY", None)
        env.pop("QINIU_SECRET_KEY", None)
        env.pop("QINIU_S3_BUCKET", None)
        env.pop("QINIU_S3_REGION", None)
        env.pop("SMTP_HOST", None)
        env.pop("SMTP_USER", None)
        env.pop("SMTP_PASS", None)
        env.pop("AGENT_INTERNAL_SECRET", None)

        # ── 密钥管理 ─────────────────────────────────────
        # 首次启动生成随机密钥并持久化到 data/secrets.env，之后复用。
        # 密钥变更会使已登录会话/后台登录态失效，因此绝不能每次启动随机。
        # 该文件包含敏感信息，请勿提交到代码仓库或随包分发。
        self._load_or_create_secrets(env)

        node_exe = str(self.server_dir / "node.exe")
        if not os.path.isfile(node_exe):
            node_exe = "node"

        strapi_cli = str(self.server_dir / "node_modules" / "@strapi" / "strapi" / "bin" / "strapi.js")

        try:
            self.process = subprocess.Popen(
                [node_exe, strapi_cli, "start"],
                cwd=str(self.server_dir),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )

            self.running = True
            self.server_ready = False

            self.reader_thread = threading.Thread(target=self._read_output, daemon=True)
            self.reader_thread.start()

            self.root.after(3000, lambda: self._monitor_startup(port))

        except FileNotFoundError:
            self.log("[GUI] 错误: 找不到 Node.js，请确保已安装 Node.js (>=20)")
            messagebox.showerror("错误",
                                 "找不到 Node.js，请确保已安装 Node.js (>=20)\n\n下载地址: https://nodejs.org")
            self._reset_ui()
        except Exception as e:
            self.log(f"[GUI] 错误: {e}")
            messagebox.showerror("错误", f"启动失败: {e}")
            self._reset_ui()

    def _load_or_create_secrets(self, env):
        """加载 data/secrets.env；不存在则生成随机密钥并写入。"""
        import secrets as pysecrets

        secrets_path = self.server_dir / "data" / "secrets.env"
        # 注意：SETUP_ADMIN_KEY（管理员安装密钥）不在此列——
        # 它由服务端每次启动自动生成并轮换，见 data/setup-admin-key.txt。
        keys = [
            "APP_KEYS",
            "ADMIN_JWT_SECRET",
            "API_TOKEN_SALT",
            "TRANSFER_TOKEN_SALT",
            "ENCRYPTION_KEY",
        ]

        values = {}
        if secrets_path.is_file():
            try:
                for line in secrets_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    k = k.strip()
                    if k in keys and v.strip():
                        values[k] = v.strip()
            except Exception as e:
                self.log(f"[GUI] 读取密钥文件失败，将重新生成: {e}")

        missing = [k for k in keys if k not in values]
        if missing:
            for k in missing:
                values[k] = pysecrets.token_urlsafe(32)

            try:
                secrets_path.parent.mkdir(parents=True, exist_ok=True)
                lines = [
                    "# InterKnot 首次启动自动生成的密钥，请妥善备份。",
                    "# 丢失该文件会导致所有已登录会话/后台登录态失效。",
                ]
                lines += [f"{k}={values[k]}" for k in keys]
                secrets_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                self.log("[GUI] 已生成随机密钥并保存到 data/secrets.env")
            except Exception as e:
                self.log(f"[GUI] 密钥文件写入失败: {e}")

        for k in keys:
            env[k] = values[k]

    def _monitor_startup(self, port):
        if not self.running:
            return
        if self._check_ready(port):
            return
        self.root.after(3000, lambda: self._monitor_startup(port))

    def _check_ready(self, port):
        if self.server_ready:
            return True
        try:
            import urllib.request
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/categories/list",
                headers={"User-Agent": "InterKnot-Launcher"}
            )
            urllib.request.urlopen(req, timeout=3)
            self.server_ready = True
            self.status_label.configure(text="● 运行中", foreground="#4ecdc4")
            self.update_links(port)
            self.log("─" * 55)
            self.log("[GUI] ✓ 服务端已启动！")
            self.log(f"[GUI] 访问地址: http://localhost:{port}")
            self.log(f"[GUI] 管理后台: http://localhost:{port}/admin")
            self.log("[GUI] 首次启动需要创建管理员账号，请访问管理后台")
            setup_key = self._load_setup_admin_key()
            if setup_key:
                self.log(f"[GUI] 首个管理员安装密钥（设置管理员时填入）: {setup_key}")
            self.log("─" * 55)
            return True
        except Exception:
            return False

    def _load_setup_admin_key(self):
        """读取 data/setup-admin-key.txt 中本次启动有效的管理员安装密钥。

        密钥由服务端每次启动自动生成并轮换（旧密钥随即失效），
        本方法在服务端 ready 之后调用，读到的即是本次有效值。
        仅本机日志显示，用于首次安装。"""
        try:
            path = self.server_dir / "data" / "setup-admin-key.txt"
            if not path.is_file():
                return None
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("SETUP_ADMIN_KEY="):
                    value = line.partition("=")[2].strip()
                    return value or None
        except Exception:
            pass
        return None

    def _read_output(self):
        try:
            for line in iter(self.process.stdout.readline, ""):
                if not self.running:
                    break
                line = line.rstrip()
                if line:
                    self.root.after(0, lambda l=line: self.log(l))
        except Exception:
            pass

    def stop_server(self):
        self.running = False
        self.server_ready = False
        self.status_label.configure(text="● 停止中...", foreground="#f0c040")
        self.start_btn.configure(state=tk.DISABLED)
        self.stop_btn.configure(state=tk.DISABLED)
        self.log("[GUI] 正在停止服务端...")

        for widget in self.link_container.winfo_children():
            widget.destroy()
        ttk.Label(self.link_container, text="服务端已停止", foreground="#888",
                  font=("Microsoft YaHei UI", 9)).pack(anchor=tk.CENTER)

        if self.process and self.process.poll() is None:
            try:
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(self.process.pid)],
                        capture_output=True,
                        creationflags=subprocess.CREATE_NO_WINDOW
                    )
                else:
                    self.process.terminate()
                    time.sleep(1)
                    if self.process.poll() is None:
                        self.process.kill()
            except Exception as e:
                self.log(f"[GUI] 停止进程时出错: {e}")

        self.log("[GUI] 服务端已停止")
        self._reset_ui()

    def _reset_ui(self):
        self.running = False
        self.server_ready = False
        self.process = None
        self.start_btn.configure(state=tk.NORMAL)
        self.stop_btn.configure(state=tk.DISABLED)
        self.status_label.configure(text="● 未启动", foreground="#888")

    def on_close(self):
        if self.running:
            if messagebox.askyesno("确认", "服务端正在运行，确定要退出吗？"):
                self.stop_server()
            else:
                return
        self.root.destroy()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    if sys.platform == "win32":
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass

    launcher = InterKnotLauncher()
    launcher.run()
