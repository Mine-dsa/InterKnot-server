# 绳网 InterKnot（二次开发整合版）

> 一个以《绝区零》（Zenless Zone Zero）为主题的粉丝社区平台：发帖、评论、私信/群聊、入站考试、等级经验、丁尼经济、称号勋章、名片装扮、举报审核、AI 角色扮演，前后端一体、开箱即用。

> **本项目是基于原项目二次开发（二开）的整合版本，并非从零原创。**

## 二次开发声明（务必先读）

本项目的**上游原项目**为：

- 服务端：[KawaYiLab/InterKnot-server](https://github.com/KawaYiLab/InterKnot-server)
- 网页前端：[KawaYiLab/InterKnot-Web](https://github.com/KawaYiLab/InterKnot-Web)

本仓库在上游代码的基础上进行了**二次开发与整合**，主要工作包括：把网页前端构建产物内置到服务端实现单端口一体化部署、补齐并增强管理后台、实现举报系统、公告与普通帖分离、单篇文章图片管理、管理员修改用户头像、内置入站考试编辑器与一键还原工具、Windows 一键启动与打包发布等（详见下文「与上游的差异」一节）。

**所有原始设计与绝大部分基础功能均来自上述两个上游仓库，版权与署名归原作者所有。** 如果你是第一次接触本项目，建议同时阅读上游仓库的说明。

---

## 目录

- [项目是什么](#项目是什么)
- [功能总览](#功能总览)
- [技术栈](#技术栈)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
- [首次部署三步](#首次部署三步)
- [管理后台](#管理后台)
- [配套工具](#配套工具)
- [配置项](#配置项)
- [数据与备份](#数据与备份)
- [构建与发布](#构建与发布)
- [与上游的差异](#与上游的差异)
- [常见问题](#常见问题)
- [致谢、许可与免责声明](#致谢许可与免责声明)

---

## 项目是什么

「绳网」（InterKnot）是游戏《绝区零》世界观中的社区网络。本项目将其做成了一个**可实际运行的社区网站**：

- **面向普通用户**：注册、入站考试、发帖（图文/Markdown/封面/分区/匿名）、评论与楼中楼、点赞、收藏、投币（丁尼）、关注、私信与群聊、签到、等级经验、称号勋章、个人主页与名片装扮、举报。
- **面向管理员**：完整的网页管理后台（用户、帖子、评论、公告、签到、称号勋章、名片、举报），以及本机专用的考题编辑器与一键还原工具。
- **可选增强**：AI 角色对话（需配置 LLM）、Meilisearch 全文搜索、Redis 实时推送、七牛云对象存储、SMTP 邮件。

默认使用 **SQLite**，**无需安装 MySQL / Redis**，解压即可运行；同时保留通过环境变量切换到 MySQL / Redis / 对象存储 / 邮件的能力。

### 适用场景

- 想快速搭建一个二次元 / 游戏主题的粉丝社区；
- 学习 Strapi v5 + Nuxt 4 的前后端一体化实践；
- 作为《绝区零》主题社团、公会或兴趣小组的内部社区。

---

## 功能总览

### 前台（网页端）

| 模块 | 说明 |
|---|---|
| 账号 | 独立注册页 `/register`，用户名 + 密码，自动生成内部邮箱；登录后可使用全部功能 |
| 入站考试 | 未通过考试前限制发帖/评论等写操作；随机抽题、限时、及格线、失败冷却、通过奖励均可由管理员配置 |
| 发帖 | 标题 + 正文（Markdown，支持图片）、最多 9 张封面、分区、匿名开关、草稿自动保存、重新编辑 |
| 互动 | 点赞、收藏、投币（丁尼）、评论（@提及、楼中楼、带图、匿名） |
| 私信（敲敲） | 一对一私聊，支持图片、表情、编辑/撤回（5 分钟内）、已读回执、输入中状态、静音、置顶 |
| 群聊 | 创建群、拉人/移人、群主管理、@AI 参与对话、每群 20 人上限 |
| 通知 | 点赞/评论/收藏/投币/私信/系统消息统一进入「敲敲」，顶部铃铛显示未读 |
| 等级经验 | 累计信用制，Lv.1–Lv.7，发帖/评论/点赞/被互动/签到等获得经验，每日有获取上限 |
| 丁尼经济 | 社区货币：注册赠送、签到、考试奖励、被打赏、管理员调整；用于改名、删帖、自定义头像等 |
| 签到 | 周期签到（周期与奖励由管理员配置），连续签到影响称号/勋章自动发放 |
| 个人主页 | 帖子/评论/统计、精选帖、修改头像/名片/签名、隐藏资料、关注/粉丝 |
| 称号与勋章 | 条件自动发放或管理员手动授予；可佩戴展示，稀有度配色 |
| 举报 | 可对**文章 / 评论 / 用户**发起举报（需登录且已通过入站考试） |

### 管理后台（`/admin`）

| 标签页 | 能力 |
|---|---|
| 用户管理 | 列表/搜索/封禁、编辑用户名/密码/邮箱/管理员/入站考核/等级/经验/丁尼、**修改头像（1:1 裁剪上传）**、删除 |
| 帖子管理 | 列表与筛选、编辑标题/正文/发布时间/置顶时间、**单篇图片管理（封面与正文图片增删改排序）**、删除 |
| 评论管理 | 搜索、删除 |
| 公告管理 | 发布公告（可选公告日期，默认 `9999-12-31` 置顶）、编辑、图片管理、删除 |
| 举报管理 | 按类型筛选，查看举报者/被举报者主页与链接、举报理由与补充说明，删除被举报内容或举报记录 |
| 签到管理 | 签到开关、每次奖励、周期长度、投币比例（管理员可设，无硬性上限） |
| 称号勋章 | 新建/编辑/启停/删除装扮，10 类触发条件与组合条件、手动授予/撤销（全程留痕）、全量重评估 |
| 名片管理 | 上传（3:1 裁剪）、改名、删除（自动卸下持有者） |

### 本机工具

| 工具 | 用途 |
|---|---|
| `InterKnot-Server.exe` / `start.bat` | 启动服务端（Windows） |
| `ExamEditor.exe` | 本机可视化编辑入站考试题库与参数（直连数据库） |
| `InterKnot-Reset.exe` | 一键还原：清空数据库/密钥/上传文件，恢复全新状态 |

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | [Strapi v5](https://strapi.io/)（5.47）+ TypeScript |
| 数据库 | 默认 SQLite（`data/data.db`），可选 MySQL |
| 前端 | [Nuxt 4](https://nuxt.com/) + Vue 3 + TypeScript（SPA，`ssr: false`） |
| 状态/请求 | Pinia、TanStack Vue Query、ofetch |
| 内容渲染 | markdown-it + DOMPurify |
| 组件/图标 | zenless-ui、Heroicons、lightGallery |
| 实时通信 | WebSocket（私信）、SSE（通知/流式回复） |
| 可选服务 | Meilisearch（搜索）、Redis（缓存/推送）、七牛云 S3（图片直传）、SMTP（邮件） |
| 运行时 | Node.js **20 ~ 24**（Windows 发布包自带 `node.exe`） |

---

## 仓库结构

工作区包含两个子项目与发布包：

```text
.
├─ InterKnot-server-main/          # 服务端（二开主体，含内置前端产物）
│  ├─ src/
│  │  ├─ api/                      # Strapi 业务 API（article/comment/exam/report/...）
│  │  ├─ middlewares/              # 鉴权、考试门禁、CSP、静态站点等
│  │  └─ index.ts                  # 启动引导：种子、回填、迁移、管理员密钥轮换
│  ├─ config/                      # Strapi 配置（数据库/中间件/插件/服务）
│  ├─ public/
│  │  ├─ web/                      # 前端构建产物（由 InterKnot-Web 构建后拷入）
│  │  ├─ admin/                    # 单文件管理后台 /admin
│  │  └─ uploads/                  # 用户上传文件
│  ├─ data/                        # 运行时数据（数据库、密钥、考试参数）
│  ├─ agent-worker/                # 可选：AI 角色后台工作进程
│  ├─ exam_editor.py / ExamEditor.exe
│  ├─ reset_tool.py / InterKnot-Reset.exe
│  ├─ launcher.py / InterKnot-Server.exe
│  └─ start.bat
│
├─ InterKnot-Web-main/             # 网页前端源码（Nuxt 4）
│  ├─ app/                         # 页面、组件、composables、stores、utils
│  ├─ public/                      # 静态资源
│  └─ nuxt.config.ts
│
└─ *.zip                           # 历史 / 最新发布包（8.5.6 等）
```

> 说明：上游将前端与服务端拆分为两个仓库；本二开版本在发布时会把前端构建产物放进服务端 `public/web`，因此**最终产物可以只部署服务端一个目录、只开一个端口**。

---

## 快速开始

### 方式一：Windows 一键包（推荐给非开发者）

1. 解压发布包（顶层目录为 `InterKnot-server-main/`）到任意路径（尽量避免特殊字符）。
2. 双击 **`start.bat`**（或 `InterKnot-Server.exe` 图形启动器）。默认端口 `1337`；自定义端口：`start.bat 8080`。
3. 首次启动会自动生成密钥并保存到 `data/secrets.env`；管理员安装密钥写入 `data/setup-admin-key.txt` 并打印在控制台。
4. 打开 `http://localhost:1337/register` 注册账号，随后按下方「首次部署三步」设置管理员。

### 方式二：源码开发

先启动服务端：

```bash
cd InterKnot-server-main/InterKnot-server-main
npm install
npm run develop          # 开发模式，默认 http://localhost:1337
```

再启动前端（另开一个终端）：

```bash
cd InterKnot-Web-main/InterKnot-Web-main
npm install
cp .env.example .env     # 按需填写后端地址
npm run dev              # 默认 http://localhost:3000
```

前端与后端分离开发时，请在 `.env` 中把 API 地址指向本地服务端。

生产部署时把前端构建产物拷进服务端即可（见「构建与发布」）。

---

## 首次部署三步

> 规则：**全站第一个注册的用户不会自动成为管理员**。需要用「安装密钥」自提首个管理员，之后的管理员由现有管理员在后台授权。

1. **注册账号**：访问 `http://localhost:1337/register`，填写用户名（≥2 字符）与密码（≥6 位）。成功后即自动登录。
2. **设置首个管理员**：
   - 打开 `http://localhost:1337/admin`，用刚注册的账号登录；
   - 在「设置为首个管理员」面板填入本次启动的 `SETUP_ADMIN_KEY`（见 `data/setup-admin-key.txt` 或控制台日志）；
   - 成功后退出重新登录即为管理员。
   - 安全机制：密钥每次启动轮换；首个管理员设置完成后该入口永久关闭。
3. **登录后台**：`/admin` 即可进入管理面板。

---

## 管理后台

后台是独立的单文件网页（`public/admin/index.html`），与前台共用账号体系：

- 地址：`http://localhost:1337/admin`
- 登录：使用前台注册的用户名/密码
- 权限：由 `isAdmin` 字段控制，管理员可在「用户管理」中把其他用户设为管理员

常用操作速查：

| 我想…… | 去哪里 |
|---|---|
| 封禁用户 / 改等级经验丁尼 | 用户管理 → 编辑 |
| 修改用户头像 | 用户管理 → 编辑 → 修改头像（1:1 裁剪） |
| 发公告（可设置置顶日期） | 公告管理 |
| 编辑帖子 / 公告正文与图片 | 帖子管理 / 公告管理 → 编辑、图片 |
| 处置举报 | 举报 |
| 改签到奖励与投币比例 | 签到管理 |
| 新建称号/勋章、手动授予 | 称号勋章 |
| 管理名片 | 名片管理 |
| 改考试题目/及格线/奖励 | `ExamEditor.exe`（本机） |
| 一键清空全部数据 | `InterKnot-Reset.exe` |

---

## 配套工具

### 入站考试编辑器（ExamEditor）

- 双击 `ExamEditor.exe`（或 `python exam_editor.py`），需与 `data/data.db` 同目录。
- 设置端口（默认 8888）→ 启动编辑器 → **必须使用日志中带一次性 token 的完整地址**访问（仅本机可用）。
- 支持题目增删改查（单选/多选/判断、选项与答案、解析、权重、启用）与考试参数（及格分、抽题数、时限、失败冷却、奖励）。
- 直连数据库，修改即时生效；已开考的场次使用开考快照，不受影响。

### 一键还原（InterKnot-Reset）

会将服务端恢复到全新状态，删除：`data/data.db*`、`data/secrets.env`、`data/setup-admin-key.txt`、`public/uploads/*`；可选同时重置 `data/exam_config.json`。

- 执行前会校验目录、探测端口占用与数据库占用；默认先打包备份到 `data/reset-backup-*.zip`，备份失败会中止删除。
- **绝不触碰**：`data/data.json`、历史备份、程序本体、`public/web`、`public/admin`。
- 操作：停止服务端 → 运行工具 → 输入 `RESET` 解锁 → 执行。

---

## 配置项

服务端配置来自环境变量。Windows 一键包会在首次启动时生成 `data/secrets.env`；源码开发可参考 `InterKnot-server-main/.env.example`。

| 变量 | 说明 |
|---|---|
| `HOST` / `PORT` | 监听地址与端口，默认 `0.0.0.0:1337` |
| `APP_KEYS` / `ADMIN_JWT_SECRET` / `API_TOKEN_SALT` / `TRANSFER_TOKEN_SALT` / `ENCRYPTION_KEY` | Strapi 密钥（一键包自动生成并持久化） |
| `DATABASE_CLIENT` | `sqlite`（默认）或 `mysql` |
| `DATABASE_FILENAME` | SQLite 文件路径，默认 `data/data.db` |
| `DATABASE_HOST/PORT/NAME/USERNAME/PASSWORD/SSL` | MySQL 连接参数 |
| `JWT_SECRET` | 用户登录 JWT 签名密钥 |
| `REDIS_URL` | 可选：Redis 缓存/实时推送 |
| `MEILISEARCH_HOST` / `MEILISEARCH_API_KEY` | 可选：全文搜索 |
| `QINIU_*` / `UPLOAD_SIZE_LIMIT` | 可选：七牛云对象存储与上传大小限制 |
| `SMTP_*` | 可选：邮件（找回密码等） |
| `AGENT_INTERNAL_SECRET` | 可选：AI 工作进程内部通信 |

> 前端 `InterKnot-Web-main` 使用 `runtimeConfig.public.apiBaseUrl` 指向后端；同源部署时留空即可。

AI 角色对话默认关闭，需要在 `agent-worker/.env` 配置 LLM（`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`）并启动工作进程。

---

## 数据与备份

所有用户数据都在服务端 `data/` 目录：

```text
data/
 ├─ data.db              # 主数据库（用户/帖子/评论/私信/装扮/举报……）
 ├─ exam_config.json     # 考试参数
 ├─ secrets.env          # 登录签名等密钥（首次启动生成）
 └─ setup-admin-key.txt  # 管理员安装密钥（每次启动轮换）
```

- **备份**：停止服务端后复制整个 `data/`；上传文件在 `public/uploads/`，建议一并备份。
- **迁移**：整目录拷贝（含 `public/uploads/`）后在新机器运行 `start.bat`。
- **`secrets.env` 丢失**：所有登录态失效，重新登录即可；管理员账号仍在。
- **切勿**把 `data/secrets.env` 提交到 Git 或公开分享。

---

## 构建与发布

### 前端（Nuxt 4）

```bash
cd InterKnot-Web-main/InterKnot-Web-main
npm install
npm run generate         # 生成静态 SPA 到 .output/public
```

将 `.output/public/*` 覆盖到服务端 `public/web/`（本项目发布包已内置该产物）。

### 服务端（Strapi 5）

```bash
cd InterKnot-server-main/InterKnot-server-main
npm install
npm run build            # 构建管理面板与编译 TS
npm run start            # 生产启动
```

常用脚本：

| 命令 | 作用 |
|---|---|
| `npm run develop` | 开发模式（热重载） |
| `npm run build` | 生产构建 |
| `npm run start` | 生产启动 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint |
| `npm test` | 单元测试（Vitest） |

### 发布包约定

Windows 发布包（如 `8.5.6正式版.zip`）遵循以下规则：

- 顶层目录为 `InterKnot-server-main/`；
- 包含 `node_modules/`、`dist/`、`build/`、`.strapi/`、`_internal/`、`__pycache__/` 与内置 `node.exe`；
- **不包含**用户数据：`data/data.db*`、`data/secrets.env`、`data/setup-admin-key.txt`；
- `public/uploads/` 为空目录（不携带用户上传内容）。

---

## 与上游的差异

本项目在上游基础上做了以下**二次开发与整合**（其余基础能力来自上游）：

- **一体化部署**：网页前端构建产物内置到服务端 `public/web`，单端口、单进程即可提供前后台；并提供 Windows 一键启动/打包。
- **自研网页管理后台** `public/admin`：用户、帖子、评论、公告、签到、称号勋章、名片等管理能力集中在一个页面。
- **举报系统**：文章/评论/用户三类举报，需登录且通过入站考试；后台可按类型筛选、查看举报者与被举报者主页链接、删除内容或记录。
- **公告与普通帖分离**：使用显式字段区分公告，公告默认以 `9999-12-31` 置顶，并包含存量数据回填与重复行修复。
- **单篇文章图片管理**：集中管理某篇文章的全部图片——封面（增/删/替换/排序）与正文内嵌图片（增/删/替换），与正文编辑器互不冲突。
- **管理员修改用户头像**：用户管理弹窗内按 1:1 拖拽/缩放裁剪后上传，直接替换旧头像。
- **入站考试编辑器**：提供本机可视化的题库与参数编辑工具。
- **一键还原工具**：带备份、端口/数据库占用检测与精确白名单删除。
- **若干稳定性与安全修复**：后台弹窗关闭、`ik_knock` 私信跳转与历史栈、公告重复、CSP 下的按钮事件等。

> 上游仍有独立更新，本项目的合并节奏与上游不一定同步。

---

## 常见问题

**Q：启动报「找不到 Node.js」？**
发布包自带 `node.exe`；若被杀毒软件删除，请安装 Node.js 20+ 或恢复 `node.exe`。

**Q：后台说「需要管理员权限」，安装密钥忘了？**
查看 `data/setup-admin-key.txt`（每次启动刷新）。若已存在管理员，该自提入口永久关闭，请联系现有管理员授权。

**Q：普通用户能做什么？被封禁后呢？**
浏览公开内容始终可以；封禁后无法登录、发言、私信、投币，个人主页对外隐藏。

**Q：帖子删了能恢复吗？**
不能，删除不可撤销（后台与前台一致）。

**Q：投币比例能设很大吗？**
可以，管理员权限内无硬性上限；只影响新投币的到账数量。

**Q：AI 角色不回复？**
默认关闭，需要在 `agent-worker/.env` 配置 LLM 并启动工作进程。

**Q：如何换端口？**
`start.bat 8080` 或启动器中修改；记得放行防火墙。

---

## 致谢、许可与免责声明

### 上游与原项目

- 服务端：[KawaYiLab/InterKnot-server](https://github.com/KawaYiLab/InterKnot-server)
- 网页前端：[KawaYiLab/InterKnot-Web](https://github.com/KawaYiLab/InterKnot-Web)

前端上游 README 同时致谢了 [share121/inter-knot](https://github.com/share121/inter-knot)、[zenless-ui](https://github.com/ChrisChan13/zenless-ui) 与 [zenless.tools](https://zenless.tools/) 等开源项目与资源。

### 许可

- 本二次开发整合版以 **GNU Affero General Public License v3.0 or later（AGPL-3.0-or-later）** 发布，完整协议见仓库根目录的 `LICENSE`。
- 上游服务端 [KawaYiLab/InterKnot-server](https://github.com/KawaYiLab/InterKnot-server) 与网页前端 [KawaYiLab/InterKnot-Web](https://github.com/KawaYiLab/InterKnot-Web) 仍遵循其各自仓库的授权与说明；再分发时请保留上游作者、仓库链接与原始许可信息。
- 如本仓库中的二次开发部分与上游原仓库许可存在冲突，以上游原仓库的许可为准。

### 免责声明

- 本项目为**粉丝自制、非官方**项目，与米哈游 / HoYoverse 无任何隶属或授权关系。
- 《绝区零》及其相关名称、角色、图像、素材等知识产权归其各自权利人所有。
- 本项目仅供学习、交流与技术研究，请勿用于商业用途；如有侵权，请联系删除。

---

> 再次强调：本项目是基于 [KawaYiLab/InterKnot-server](https://github.com/KawaYiLab/InterKnot-server) 与 [KawaYiLab/InterKnot-Web](https://github.com/KawaYiLab/InterKnot-Web) 的**二次开发（二开）**，感谢原作者的贡献。
