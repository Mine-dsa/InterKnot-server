/* 离线运行验证（Node 全流程）：最小 PATH + 包内 node.exe */
import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';

const WORK = 'E:/opencode/InterKnot-server-main/InterKnot-server-main';
const OUT = 'C:/Users/ycc/AppData/Local/Temp/opencode/offline2-out.log';
const BASE = 'http://127.0.0.1:1339';

// 杀旧监听
try {
  const conn = execSync('powershell -Command "(Get-NetTCPConnection -LocalPort 1339 -State Listen -ErrorAction SilentlyContinue).OwningProcess"').toString().trim();
  if (conn) execSync(`taskkill /PID ${conn} /F`);
} catch {}
await new Promise((r) => setTimeout(r, 2000));

// 清干净数据（模拟首次解压）
for (const f of ['data/data.db', 'data/data.db-journal', 'data/data.db-wal', 'data/data.db-shm', 'data/secrets.env', 'data/setup-admin-key.txt']) {
  fs.rmSync(WORK + '/' + f, { force: true });
}
fs.rmSync(WORK + '/public/uploads', { recursive: true, force: true });
fs.mkdirSync(WORK + '/public/uploads');
fs.rmSync(OUT, { force: true });

// 最小 PATH（模拟无运行库电脑）：仅 System32
const env = {
  PATH: 'C:\\Windows\\System32;C:\\Windows',
  SystemRoot: 'C:\\Windows',
  DATABASE_CLIENT: 'sqlite',
  DATABASE_FILENAME: 'data/data.db',
  HOST: '127.0.0.1',
  PORT: '1339',
  JWT_SECRET: 'smoke-test-secret',
};
const outFd = fs.openSync(OUT, 'w');
const srv = spawn(WORK + '/node.exe', ['node_modules/@strapi/strapi/bin/strapi.js', 'start'], {
  cwd: WORK, env, stdio: ['ignore', outFd, outFd],
});
console.log('spawned bundled node.exe pid=', srv.pid);

let ready = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try { if (fs.readFileSync(OUT, 'utf8').includes('Strapi started successfully')) { ready = true; break; } } catch {}
  if (srv.exitCode !== null) { console.log('SERVER EXITED', srv.exitCode); process.exit(1); }
}
console.log('ready =', ready);
if (!ready) { srv.kill('SIGKILL'); process.exit(1); }

const fail = [];
const need = (tag, ok) => { console.log(`[${tag}] ${ok ? 'OK' : '✗ FAIL'}`); if (!ok) fail.push(tag); };

let r = await fetch(BASE + '/api/categories/list');
need('API categories', r.status === 200);
r = await fetch(BASE + '/');
let html = await r.text();
need('frontend index', r.status === 200 && html.length > 500);
r = await fetch(BASE + '/admin');
need('admin page', r.status === 200);
r = await fetch(BASE + '/images/banner.png');
need('image asset (banner.png)', r.status === 200);
r = await fetch(BASE + '/api/auth/local/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'offline' + Date.now(), password: 'test123456', email: 'o' + Date.now() + '@t.local' }),
});
need('register (db write works)', r.status === 200);

srv.kill();
await new Promise((r) => setTimeout(r, 1500));

// 恢复干净状态
for (const f of ['data/data.db', 'data/data.db-journal', 'data/data.db-wal', 'data/data.db-shm', 'data/secrets.env', 'data/setup-admin-key.txt']) {
  fs.rmSync(WORK + '/' + f, { force: true });
}
fs.rmSync(WORK + '/public/uploads', { recursive: true, force: true });
fs.mkdirSync(WORK + '/public/uploads');

console.log(fail.length ? `\n=== ${fail.length} FAIL ===` : '\n=== 离线运行验证通过：最小 PATH + 包内 node.exe 完整可用 ===');
process.exit(fail.length ? 1 : 0);
