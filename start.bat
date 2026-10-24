@echo off
title 绳网 InterKnot 服务端
cd /d "%~dp0"

set HOST=0.0.0.0
set PORT=%1
if "%PORT%"=="" set PORT=1337

set DATABASE_CLIENT=sqlite
set DATABASE_FILENAME=data/data.db

set NODE=%~dp0node.exe
if not exist "%NODE%" set NODE=node

REM ── 密钥管理 ──────────────────────────────────────────
REM 首次启动生成随机密钥并持久化到 data\secrets.env，之后复用。
REM 密钥变更会使已登录会话/后台登录态失效，因此绝不能每次启动随机。
REM 该文件包含敏感信息，请勿提交到代码仓库或随包分发。

if not exist "%~dp0data" mkdir "%~dp0data"

if not exist "%~dp0data\secrets.env" (
  echo [secrets] 首次启动：正在生成随机密钥...
  "%NODE%" -e "const fs=require('fs'),c=require('crypto');const p=process.argv[1];const items=[['APP_KEYS',c.randomBytes(32).toString('base64')],['ADMIN_JWT_SECRET',c.randomBytes(32).toString('base64')],['API_TOKEN_SALT',c.randomBytes(32).toString('base64')],['TRANSFER_TOKEN_SALT',c.randomBytes(32).toString('base64')],['ENCRYPTION_KEY',c.randomBytes(32).toString('base64')]];fs.writeFileSync(p,items.map(i=>i[0]+'='+i[1]).join('\n')+'\n');" "%~dp0data\secrets.env" || (
    echo [secrets] 密钥生成失败，请检查 Node.js 是否可用
    pause
    exit /b 1
  )
  echo [secrets] 已生成 data\secrets.env（请妥善备份，丢失将导致所有登录态失效）
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0data\secrets.env") do set "%%A=%%B"

echo ==================================================
echo   绳网 InterKnot 服务端
echo ==================================================
echo.
echo   访问地址:   http://localhost:%PORT%
echo   注册账号:   http://localhost:%PORT%/register
echo   管理后台:   http://localhost:%PORT%/admin
echo   数据目录:   %~dp0data
echo.
echo   首次使用: 请先访问 /register 注册账号
echo   首个管理员: 在 /admin 设置管理员时填入安装密钥
echo   （密钥由服务端每次启动生成，见 data\setup-admin-key.txt 与启动日志）
echo   管理后台: 注册后在 /admin 使用相同账号登录
echo ==================================================
echo.

call "%NODE%" node_modules\@strapi\strapi\bin\strapi.js start
pause
