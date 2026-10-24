import path from 'path';
import fs from 'fs';

const WEB_ROOT = path.join(__dirname, '..', '..', '..', 'public', 'web');
const ADMIN_ROOT = path.join(__dirname, '..', '..', '..', 'public', 'admin');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function getMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/** 前端静态资源的基础安全头（无破坏性：不改缓存与加载行为） */
const applySecurityHeaders = (ctx: any) => {
  ctx.set('X-Content-Type-Options', 'nosniff');
  ctx.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  ctx.set('X-Frame-Options', 'SAMEORIGIN');
};

async function serveFile(ctx: any, filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    // 目录不能直接作为响应流（createReadStream 会异步失败导致 500）
    if (!stat.isFile()) return false;
    applySecurityHeaders(ctx);
    ctx.set('Content-Type', getMime(filePath));
    ctx.set('Content-Length', stat.size.toString());
    ctx.set('Cache-Control', 'public, max-age=3600');
    ctx.body = fs.createReadStream(filePath);
  } catch {
    return false;
  }
  return true;
}

export default () => {
  return async (ctx: any, next: any) => {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
      return next();
    }

    const urlPath = ctx.path || '/';

    if (urlPath.startsWith('/api/') ||
        urlPath.startsWith('/uploads/') ||
        urlPath.startsWith('/i18n/') ||
        urlPath.startsWith('/content-manager/') ||
        urlPath.startsWith('/content-type-builder/') ||
        urlPath.startsWith('/email/') ||
        urlPath.startsWith('/upload/') ||
        urlPath.startsWith('/users-permissions/') ||
        urlPath.startsWith('/.well-known/') ||
        urlPath.startsWith('/_next/')) {
      return next();
    }

    if (urlPath === '/admin' || urlPath.startsWith('/admin/')) {
      const adminIndexPath = path.join(ADMIN_ROOT, 'index.html');
      if (!fs.existsSync(adminIndexPath)) {
        return next();
      }

      if (urlPath === '/admin') {
        applySecurityHeaders(ctx);
        ctx.set('Content-Type', 'text/html; charset=utf-8');
        ctx.set('Cache-Control', 'no-cache');
        ctx.body = fs.createReadStream(adminIndexPath);
        return;
      }

      const relPath = urlPath.slice('/admin/'.length) || 'index.html';
      const adminFilePath = path.normalize(path.join(ADMIN_ROOT, relPath));

      if (!adminFilePath.startsWith(ADMIN_ROOT)) {
        return next();
      }

      const served = await serveFile(ctx, adminFilePath);
      if (!served) {
        applySecurityHeaders(ctx);
        ctx.set('Content-Type', 'text/html; charset=utf-8');
        ctx.set('Cache-Control', 'no-cache');
        ctx.body = fs.createReadStream(adminIndexPath);
      }
      return;
    }

    const indexPath = path.join(WEB_ROOT, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return next();
    }

    if (urlPath === '/index.html' || urlPath === '/200.html' || urlPath === '/404.html') {
      return next();
    }

    let filePath = path.join(WEB_ROOT, urlPath === '/' ? 'index.html' : urlPath.slice(1));
    filePath = path.normalize(filePath);

    if (!filePath.startsWith(WEB_ROOT)) {
      return next();
    }

    let served = await serveFile(ctx, filePath);

    // 目录型预渲染路由（如 /manage、/level）：尝试目录下的 index.html
    if (!served && !path.extname(filePath)) {
      served = await serveFile(ctx, path.join(filePath, 'index.html'));
    }

    if (!served && !path.extname(filePath)) {
      served = await serveFile(ctx, filePath + '.html');
    }

    // SPA 兜底：其余路径回退到 index.html（客户端路由接管）
    if (!served) {
      applySecurityHeaders(ctx);
      ctx.set('Content-Type', 'text/html; charset=utf-8');
      ctx.set('Cache-Control', 'no-cache');
      ctx.body = fs.createReadStream(indexPath);
    }
  };
};
