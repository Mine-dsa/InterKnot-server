module.exports = [
  'strapi::errors',
  {
    name: 'global::error-format',
    config: {},
  },
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
          'connect-src': ["'self'", 'https:'],
          'img-src': [
            "'self'",
            'data:',
            'blob:',
            '*.qiniucs.com', 
            'image.tiwat.cn', 
          ],
          'media-src': [
            "'self'",
            'data:',
            'blob:',
            '*.qiniucs.com',
            'image.tiwat.cn',
          ],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  {
    name: 'strapi::cors',
    config: {
      origin: [
        'https://tiwat.cn',
        'https://www.tiwat.cn',
        'https://interk.net',
        'https://www.interk.net',
        'https://dev.interk.net',
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173',
      ],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      headers: ['Content-Type', 'Authorization', 'Origin', 'Accept'],
      keepHeaderOnError: true,
    },
  },
  'strapi::poweredBy',
  'strapi::logger',
  // 全局 rate-limit 已禁用：authReadLimit=120/min 对正常浏览偶发触发误伤太大。
  // 关键写入路径已有局部限流（如 DM 发消息走 checkAndRecordSendRate，5 条/秒 + 60 条/分钟）。
  // 如需恢复全局节流，把 'global::rate-limit' 重新加回这里即可，源文件 src/middlewares/rate-limit.ts 保留可用。
  'strapi::query',
  {
    name: 'global::sanitize-cache-query',
    config: {},
  },
  {
    name: 'strapi::body',
    config: {
      formLimit: '30mb',
      jsonLimit: '30mb',
      textLimit: '30mb',
      formidable: {
        maxFileSize: 30 * 1024 * 1024,
      },
    },
  },
  {
    name: 'global::upload-validate',
    config: {
      allowedMimeTypes: [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/avif',
      ],
      maxBytesToCheck: 4100,
    },
  },
  'strapi::session',
  'strapi::favicon',
  {
    name: 'global::serve-web',
    config: {},
  },
  'strapi::public',
];
