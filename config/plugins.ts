const ARTICLE_SEARCH_TEXT_LIMIT = 3000;

/** 富文本去标记：HTML 标签 + 常见 Markdown 语法，只留可检索的纯文本。 */
const toPlainText = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ARTICLE_SEARCH_TEXT_LIMIT);
};

module.exports = ({ env }) => {
  const hasMeilisearch = env('MEILISEARCH_HOST') && env('MEILISEARCH_API_KEY');
  const hasRedis = env('REDIS_URL');
  const hasQiniu = env('QINIU_S3_ENDPOINT') && env('QINIU_ACCESS_KEY');
  const hasEmail = env('SMTP_HOST') && env('SMTP_USER');

  const plugins: any = {};

  if (hasMeilisearch) {
    plugins.meilisearch = {
      config: {
        host: env('MEILISEARCH_HOST'),
        apiKey: env('MEILISEARCH_API_KEY'),
        article: {
          indexName: 'article',
          entriesQuery: {
            status: 'published',
            populate: {
              category: { fields: ['name', 'slug'] },
              author: { fields: ['documentId', 'name'] },
            },
          },
          transformEntry({ entry }: { entry: any }) {
            return {
              id: entry.id,
              documentId: entry.documentId,
              title: entry.title ?? '',
              text: toPlainText(entry.text),
              isAnonymous: entry.isAnonymous === true,
              authorName: entry.isAnonymous === true ? null : (entry.author?.name ?? null),
              categoryName: entry.category?.name ?? null,
              categorySlug: entry.category?.slug ?? null,
              views: entry.views ?? 0,
              likescount: entry.likescount ?? 0,
              commentscount: entry.commentscount ?? 0,
              updatedAt: entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0,
            };
          },
          settings: {
            searchableAttributes: ['title', 'text', 'authorName', 'categoryName'],
            filterableAttributes: ['categorySlug', 'isAnonymous'],
            sortableAttributes: ['updatedAt', 'views', 'likescount'],
            rankingRules: [
              'words',
              'typo',
              'proximity',
              'attribute',
              'sort',
              'exactness',
              'updatedAt:desc',
            ],
          },
        },
      },
    };
  } else {
    plugins.meilisearch = { enabled: false };
  }

  if (hasRedis) {
    plugins['strapi-cache'] = {
      enabled: true,
      config: {
        debug: false,
        ttl: 1000 * 60,
        cacheableRoutes: [
          '/api/articles',
          '/api/comments',
          '/api/authors',
          '/api/article-reads'
        ],
        strategy: {
          'content-types': [
            {
              contentType: 'api::article-read.article-read',
              maxAge: 1000 * 60,
            }
          ]
        },
        provider: 'redis',
        redisConfig: env('REDIS_URL', 'redis://127.0.0.1:6379'),
        cacheHeaders: true,
        cacheAuthorizedRequests: false,
        autoPurgeCache: true,
        autoPurgeCacheOnStart: true,
      },
    };
  }

  plugins.upload = {
    config: {
      sizeLimit: env.int('UPLOAD_SIZE_LIMIT', 30 * 1024 * 1024),
      ...(hasQiniu ? {
        provider: '@strapi/provider-upload-aws-s3',
        providerOptions: {
          s3Options: {
            endpoint: env('QINIU_S3_ENDPOINT'),
            region: env('QINIU_S3_REGION'),
            forcePathStyle: true,
            credentials: {
              accessKeyId: env('QINIU_ACCESS_KEY'),
              secretAccessKey: env('QINIU_SECRET_KEY'),
            },
          },
          params: { Bucket: env('QINIU_S3_BUCKET') },
          baseUrl: 'https://image.tiwat.cn',
        },
      } : {
        provider: 'local',
        providerOptions: {},
      }),
    },
  };

  if (hasEmail) {
    plugins.email = {
      config: {
        provider: 'nodemailer',
        providerOptions: {
          host: env('SMTP_HOST'),
          port: env.int('SMTP_PORT', 587),
          secure: env.bool('SMTP_SECURE', false),
          auth: {
            user: env('SMTP_USER'),
            pass: env('SMTP_PASS'),
          },
        },
        settings: {
          defaultFrom: env('SMTP_DEFAULT_FROM'),
          defaultReplyTo: env('SMTP_DEFAULT_REPLYTO'),
        },
      },
    };
  }

  return plugins;
};
