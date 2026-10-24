/* 按 8.5.5 规则重打包：包含全部内容（仅排除用户数据 db/secrets/setup-key），顶层 InterKnot-server-main */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

const WORK = 'E:/opencode/InterKnot-server-main/InterKnot-server-main';
const ZIP_TMP = 'E:/opencode/pack856.zip';
const ZIP_FINAL = 'E:/opencode/8.5.6正式版.zip';
const TAR = 'C:/Windows/System32/tar.exe';

// 数据干净确认（与 8.5.5 规则一致：不含用户数据库与密钥）
for (const f of ['data/data.db', 'data/data.db-journal', 'data/data.db-wal', 'data/data.db-shm', 'data/secrets.env', 'data/setup-admin-key.txt']) {
  if (fs.existsSync(WORK + '/' + f)) {
    console.log('RESIDUE found, abort:', f);
    process.exit(1);
  }
}
// uploads 清空（打包规则：不包含用户上传内容）
fs.rmSync(WORK + '/public/uploads', { recursive: true, force: true });
fs.mkdirSync(WORK + '/public/uploads');

fs.rmSync(ZIP_TMP, { force: true });
console.log('tar packing (top-level = InterKnot-server-main, matching 8.5.5 rule)...');
// -C 切到外层目录，归档内层项目目录 → zip 顶层为 InterKnot-server-main/
const r = spawnSync(TAR, ['-a', '-cf', ZIP_TMP, '-C', 'E:/opencode/InterKnot-server-main', 'InterKnot-server-main'], { stdio: 'inherit' });
if (r.status !== 0) { console.log('tar failed', r.status); process.exit(1); }

fs.rmSync(ZIP_FINAL, { force: true });
fs.renameSync(ZIP_TMP, ZIP_FINAL);
const size = fs.statSync(ZIP_FINAL).size;
console.log(`=== DONE: 8.5.6正式版.zip (${(size / 1024 / 1024).toFixed(1)} MB) ===`);
