import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { LifecycleEvent } from './types/strapi';
import type { Core } from '@strapi/strapi';
export default {
  register() {},

  async bootstrap({ strapi }: any) {
    patchUploadProviderDelete(strapi);
    await backfillBumpedAt(strapi);
    await exemptLegacyUsersFromExam(strapi);
    await backfillAnnouncements(strapi);
    await repairDuplicatePublishedArticles(strapi);
    rotateSetupAdminKey(strapi);

    strapi.db.lifecycles.subscribe({
      models: ['plugin::users-permissions.user'],
      async afterCreate(event: LifecycleEvent) {
        await ensureAuthorForUser(event, strapi);
      },
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startWsServer } = require('./api/conversation/utils/ws-server');
      startWsServer(strapi);
    } catch (err) {
      strapi.log.warn(`[dm-ws] failed to start WebSocket server: ${err}`);
    }

    patchAuthVerify(strapi);
    await seedExamQuestions(strapi);
    await seedDefaultAvatars(strapi);
    await seedDefaultCosmetics(strapi);
    await seedPermissions(strapi);
  },
};

/**
 * 首次启动种子：等级称号目录（与前端 LEVEL_TITLES 对齐）+ 成就勋章示例。
 * 仅在对应表为空时写入；管理员可随后在管理中心自由增删改。
 */
async function seedDefaultCosmetics(strapi: Core.Strapi) {
  try {
    const TITLE_UID = 'api::title.title';
    const MEDAL_UID = 'api::medal.medal';

    const titleCount = await strapi.db.query(TITLE_UID).count({});
    if (titleCount === 0) {
      const titles = [
        { name: '新手绳匠', description: '刚刚踏上绳网的新人', rarity: 'common', condition: { type: 'level', min: 1 }, sortOrder: 1 },
        { name: '见习绳匠', description: '已适应绳网的节奏', rarity: 'common', condition: { type: 'level', min: 2 }, sortOrder: 2 },
        { name: '正式绳匠', description: '绳网认可的正式成员', rarity: 'rare', condition: { type: 'level', min: 3 }, sortOrder: 3 },
        { name: '资深绳匠', description: '身经百战的绳匠', rarity: 'rare', condition: { type: 'level', min: 4 }, sortOrder: 4 },
        { name: '精英绳匠', description: '绳网中的佼佼者', rarity: 'epic', condition: { type: 'level', min: 5 }, sortOrder: 5 },
        { name: '传奇绳匠', description: '写下传奇的绳匠', rarity: 'legendary', condition: { type: 'level', min: 6 }, sortOrder: 6 },
        { name: '传说绳匠', description: '绳网传说中的存在', rarity: 'legendary', condition: { type: 'level', min: 7 }, sortOrder: 7 },
      ];
      for (const item of titles) {
        await strapi.db.query(TITLE_UID).create({ data: item });
      }
      strapi.log.info('[cosmetics] seeded 7 default titles');
    }

    const medalCount = await strapi.db.query(MEDAL_UID).count({});
    if (medalCount === 0) {
      const medals = [
        { name: '入站考核通过', description: '成功通过绳网入站考试', rarity: 'common', condition: { type: 'exam_passed' }, sortOrder: 1 },
        { name: '初次发帖', description: '在绳网发布第一篇帖子', rarity: 'common', condition: { type: 'article_count', min: 1 }, sortOrder: 2 },
        { name: '破百点赞', description: '累计收到 100 个点赞', rarity: 'rare', condition: { type: 'like_received', min: 100 }, sortOrder: 3 },
        { name: '坚持签到', description: '连续签到 7 天', rarity: 'rare', condition: { type: 'checkin_consecutive_days', min: 7 }, sortOrder: 4 },
        { name: '投币先锋', description: '累计投出 50 丁尼', rarity: 'epic', condition: { type: 'denny_given', min: 50 }, sortOrder: 5 },
      ];
      for (const item of medals) {
        await strapi.db.query(MEDAL_UID).create({ data: item });
      }
      strapi.log.info('[cosmetics] seeded 5 default medals');
    }
  } catch (err) {
    strapi.log.warn(`[cosmetics] seed failed: ${err}`);
  }
}

/**
 * SECURITY-DEFERRED（安全专项押后）：
 * 此补丁会让所有携带 credentials.id 的请求跳过 Strapi 原生 RBAC 权限校验，
 * 授权完全依赖各路由手动配置的中间件/策略。按本轮迭代决策保留该行为；
 * 恢复原生 RBAC 校验已列入后续安全专项，改动前必须回归全部前端调用。
 */
function patchAuthVerify(strapi: Core.Strapi) {
  try {
    const authService = strapi.get('auth');
    if (!authService || typeof authService.verify !== 'function') {
      return;
    }

    const originalVerify = authService.verify.bind(authService);
    authService.verify = async (auth: any, config: any) => {
      // 已携带 credentials.id 的请求直接放行（跳过权限校验，保持旧行为）
      if (auth?.credentials?.id) {
        return;
      }
      try {
        return await originalVerify(auth, config);
      } catch {
        // 校验失败时降级为“仅认证”，保持旧行为
      }
    };
    strapi.log.info('[bootstrap] patched auth.verify to skip permission check');
  } catch (e) {
    strapi.log.warn(`[bootstrap] failed to patch auth: ${e}`);
  }
}

async function ensureAuthorForUser(event: LifecycleEvent, strapi: Core.Strapi) {
  const { result } = event;
  if (!result?.id) return;
  try {
    const exists = await strapi.db
      .query('api::author.author')
      .findOne({ where: { user: result.id } });
    if (!exists) {
      await strapi.documents('api::author.author').create({
        data: { name: result.username, user: result.id },
      });
    }
  } catch (err) {
    strapi.log.error(`Author creation error: ${err}`);
  }
}

function patchUploadProviderDelete(strapi: Core.Strapi) {
  const uploadPlugin = strapi.plugin('upload');
  const provider = uploadPlugin?.provider;

  if (!provider || typeof provider.delete !== 'function' || provider.__directUploadDeletePatched) {
    return;
  }

  const originalDelete = provider.delete.bind(provider);

  provider.delete = async (file: any, customParams = {}) => {
    const objectKey = getDirectUploadObjectKey(file);
    if (!objectKey) {
      return originalDelete(file, customParams);
    }

    const normalizedFile = buildDeletePayloadFromObjectKey(strapi, file, objectKey);
    return originalDelete(normalizedFile, customParams);
  };

  provider.__directUploadDeletePatched = true;
}

function getDirectUploadObjectKey(file: any) {
  const metadata = file?.provider_metadata;
  if (!metadata || typeof metadata !== 'object') {
    return '';
  }

  if (metadata.directUpload !== true) {
    return '';
  }

  return typeof metadata.objectKey === 'string' ? metadata.objectKey.trim() : '';
}

function buildDeletePayloadFromObjectKey(strapi: Core.Strapi, file: any, objectKey: string) {
  const rootPath = getUploadRootPath(strapi);
  const normalizedKey = normalizeObjectKey(objectKey);
  const normalizedRoot = normalizeObjectKey(rootPath);
  const expectedFilename = `${file.hash}${file.ext ?? ''}`;

  let relativeKey = normalizedKey;
  if (normalizedRoot && relativeKey.startsWith(`${normalizedRoot}/`)) {
    relativeKey = relativeKey.slice(normalizedRoot.length + 1);
  }

  if (!relativeKey.endsWith(expectedFilename)) {
    return file;
  }

  const pathValue = relativeKey.slice(0, relativeKey.length - expectedFilename.length).replace(/\/+$/g, '');

  return {
    ...file,
    path: pathValue || undefined,
  };
}

function getUploadRootPath(strapi: Core.Strapi) {
  const uploadConfig = strapi.config.get('plugin::upload') as
    | { providerOptions?: { rootPath?: string } }
    | undefined;
  return uploadConfig?.providerOptions?.rootPath || '';
}

function normalizeObjectKey(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/^\/+|\/+$/g, '');
}

async function exemptLegacyUsersFromExam(strapi: Core.Strapi) {
  try {
    const store = strapi.store({ type: 'plugin', name: 'exam' });
    const done = await store.get({ key: 'legacyExemptionDone' });
    if (done) return;

    const knex = strapi.db.connection;
    const updated = await knex('up_users')
      .where((qb: any) => qb.where('exam_passed', false).orWhereNull('exam_passed'))
      .update({ exam_passed: true, exam_passed_at: new Date() });

    await store.set({ key: 'legacyExemptionDone', value: true });
    strapi.log.info(`[exam] exempted ${updated} legacy users from entrance exam`);
  } catch (err) {
    strapi.log.error(`[exam] legacy exemption failed: ${err}`);
  }
}

async function backfillBumpedAt(strapi: Core.Strapi) {
  try {
    const knex = strapi.db.connection;
    const updated = await knex('articles')
      .whereNull('bumped_at')
      .update({ bumped_at: knex.raw('COALESCE(published_at, updated_at)') });
    if (updated > 0) {
      strapi.log.info(`[bumpedAt] backfilled ${updated} articles`);
    }
  } catch (err) {
    strapi.log.warn(`[bumpedAt] backfill failed: ${err}`);
  }
}

/**
 * 一次性回填：历史「公告」是 author 为空的已发布文章（旧 createAnnouncement 不写 author）。
 * 新版本用显式字段 isAnnouncement 区分；启动时把存量无作者文章标记为公告（幂等，仅执行一次）。
 */
async function backfillAnnouncements(strapi: Core.Strapi) {
  const ARTICLE_UID = 'api::article.article';
  try {
    const store = strapi.store({ type: 'plugin', name: 'admin' });
    const done = await store.get({ key: 'announcementBackfillDone' });
    if (done) return;

    let updated = 0;
    let offset = 0;
    const BATCH = 200;
    // 分批扫描（按关系判空在 JS 侧完成，避免依赖 link 表列名）
    for (;;) {
      const rows = await strapi.db.query(ARTICLE_UID).findMany({
        where: { isAnnouncement: { $ne: true } },
        select: ['id'],
        populate: { author: { select: ['id'] } },
        orderBy: { id: 'asc' },
        offset,
        limit: BATCH,
      });
      if (!rows?.length) break;
      for (const row of rows) {
        if (!row?.author?.id) {
          await strapi.db.query(ARTICLE_UID).update({
            where: { id: row.id },
            data: { isAnnouncement: true },
          });
          updated += 1;
        }
      }
      if (rows.length < BATCH) break;
      offset += BATCH;
    }

    await store.set({ key: 'announcementBackfillDone', value: true });
    if (updated > 0) {
      strapi.log.info(`[announcement] backfilled ${updated} legacy announcements`);
    }
  } catch (err) {
    strapi.log.warn(`[announcement] backfill failed: ${err}`);
  }
}

/**
 * 一次性修复：历史 `createAnnouncement` / `updateArticle` 曾把 published_at 写到
 * 所有行（含草稿行），导致同一篇文档出现多行 published_at 非空，列表按
 * `publishedAt $notNull` 过滤时同一公告重复展示。
 *
 * 修复策略（幂等）：对同一 (document_id, locale) 下 published_at 非空的行多于一条时，
 * 仅保留 id 最大的一行（draftAndPublish 下已发布行总是后创建，id 更大），
 * 其余行 published_at 置空，恢复为草稿行。
 */
async function repairDuplicatePublishedArticles(strapi: Core.Strapi) {
  try {
    const knex = strapi.db.connection;
    const dupes = await knex('articles')
      .select('document_id', 'locale')
      .whereNotNull('published_at')
      .groupBy('document_id', 'locale')
      .havingRaw('COUNT(*) > 1');

    let fixed = 0;
    for (const g of dupes) {
      const q = knex('articles')
        .select('id')
        .where('document_id', g.document_id)
        .whereNotNull('published_at')
        .orderBy('id', 'desc');
      if (g.locale === null || g.locale === undefined) q.whereNull('locale');
      else q.where('locale', g.locale);

      const rows = await q;
      const removeIds = (rows || []).slice(1).map((r: any) => r.id);
      if (removeIds.length > 0) {
        await knex('articles').whereIn('id', removeIds).update({ published_at: null });
        fixed += removeIds.length;
      }
    }

    if (fixed > 0) {
      strapi.log.warn(`[announcement] repaired ${fixed} duplicate published article rows`);
    }
  } catch (err) {
    strapi.log.warn(`[announcement] duplicate repair failed: ${err}`);
  }
}

async function seedExamQuestions(strapi: Core.Strapi) {
  const QUESTION_UID = 'api::exam-question.exam-question';
  try {
    const count = await strapi.db.query(QUESTION_UID).count({});
    if (count > 0) return;

    const questions = [
      { question: '一加一等于几？', type: 'single', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }, { key: 'C', text: '3' }, { key: 'D', text: '4' }], correctKeys: ['B'], weight: 1, enabled: true },
      { question: '请选出以下选项中的字母？（多选）', type: 'multiple', options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }, { key: 'C', text: 'C' }, { key: 'D', text: '1' }], correctKeys: ['A', 'B', 'C'], weight: 2, enabled: true },
      { question: '一加一是不是等于一？', type: 'boolean', options: [{ key: 'T', text: '正确' }, { key: 'F', text: '错误' }], correctKeys: ['F'], weight: 1, enabled: true },
    ];

    for (const q of questions) {
      await strapi.db.query(QUESTION_UID).create({ data: q });
    }

    strapi.log.info('[exam] seeded 3 default questions');
  } catch (err) {
    strapi.log.warn(`[exam] seed failed: ${err}`);
  }
}

/**
 * 为 authenticated 角色补种 RBAC 权限。
 *
 * Strapi 5 的 permission 内容类型只有 action + role(manyToOne)——v4 的
 * subject/properties/conditions 列已不存在，旧的裸 SQL 插入从未成功过。
 * 现改为 db.query 走 ORM（自动处理 up_permissions_role_lnk 关系表）。
 * 当前 auth.verify 补丁（见上方）会跳过权限校验，这些记录处于休眠态；
 * 待安全专项恢复原生 RBAC 后它们将成为实际的授权依据。
 */
async function seedPermissions(strapi: Core.Strapi) {
  try {
    const role = await strapi.db.query('plugin::users-permissions.role').findOne({
      where: { type: 'authenticated' },
      select: ['id'],
    });
    if (!role) return;

    const existingCount = await strapi.db
      .query('plugin::users-permissions.permission')
      .count({ where: { role: { id: role.id } } });
    if (existingCount > 5) return;

    const ctActions: [string, string[]][] = [
      ['api::article.article', ['create','find','findOne','update','delete']],
      ['api::comment.comment', ['create','find','findOne','delete','update']],
      ['api::like.like', ['create','find','findOne','delete']],
      ['api::favorite.favorite', ['create','find','findOne','delete']],
      ['api::follow.follow', ['create','find','findOne','delete']],
      ['api::author.author', ['find','findOne']],
      ['api::article-read.article-read', ['create','find']],
      ['api::notification.notification', ['find','findOne','update']],
      ['api::conversation.conversation', ['create','find','findOne','update']],
      ['api::message.message', ['create','find','findOne']],
      ['api::conversation-member.conversation-member', ['find','create']],
      ['api::user-denny.user-denny', ['find']],
      ['api::user-exp.user-exp', ['find']],
      ['api::check-in.check-in', ['create','find']],
      ['api::exam.exam', ['find']],
      ['api::exam-attempt.exam-attempt', ['create','find']],
      ['api::exam-question.exam-question', ['find']],
    ];

    let seeded = 0;
    for (const [subject, actions] of ctActions) {
      for (const action of actions) {
        await strapi.db.query('plugin::users-permissions.permission').create({
          data: { action: `${subject}.${action}`, role: role.id },
        });
        seeded += 1;
      }
    }

    if (seeded > 0) {
      strapi.log.info(`[permissions] seeded ${seeded} permissions for authenticated role`);
    }
  } catch (err) {
    strapi.log.warn(`[permissions] seed failed: ${err}`);
  }
}

async function seedDefaultAvatars(strapi: Core.Strapi) {
  const AVATAR_UID = 'api::avatar.avatar';
  try {
    const count = await strapi.db.query(AVATAR_UID).count({});
    if (count > 0) return;

    const defaults = [
      { name: '默认头像', type: 'character' },
      { name: '新艾利都', type: 'city' },
      { name: '绳网快讯', type: 'news' },
    ];

    for (const a of defaults) {
      await strapi.db.query(AVATAR_UID).create({ data: a });
    }

    strapi.log.info('[avatar] seeded 3 default avatars');
  } catch (err) {
    strapi.log.warn(`[avatar] seed failed: ${err}`);
  }
}

/**
 * 管理员安装密钥（SETUP_ADMIN_KEY）：
 * 每次服务端启动都重新生成（随机 32 位十六进制），并做两件事：
 *   1) 覆盖 process.env.SETUP_ADMIN_KEY —— /admin 的「设置为首个管理员」端点
 *      从环境变量读取，无需改动控制器；
 *   2) 写入 data/setup-admin-key.txt（覆盖）—— 启动器/运维随时可查本次有效密钥。
 *
 * 密钥随重启轮换：旧密钥立即失效，未被使用过的票据不会长期暴露在磁盘上。
 * 首个管理员设置完成后，该端点被初始化锁永久关闭，密钥仅对首次部署有意义。
 * 若部署方显式配置了 SETUP_ADMIN_KEY 环境变量，同样会被轮换值覆盖——
 * 密钥的唯一权威来源是服务端本次启动。
 */
function rotateSetupAdminKey(strapi: Core.Strapi) {
  try {
    const key = crypto.randomBytes(16).toString('hex');
    process.env.SETUP_ADMIN_KEY = key;

    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const keyFile = path.join(dataDir, 'setup-admin-key.txt');
    fs.writeFileSync(
      keyFile,
      [
        '# 管理员安装密钥（每次服务端启动自动更换，旧密钥随即失效）',
        '# 用途：首次部署时在 /admin「设置为首个管理员」面板填入。',
        '# 首个管理员设置完成后此密钥不再有任何作用。',
        `SETUP_ADMIN_KEY=${key}`,
        '',
      ].join('\n'),
      'utf-8'
    );

    strapi.log.warn(`[setup-admin] 本次启动的管理员安装密钥: ${key}`);
    strapi.log.warn('[setup-admin] 已写入 data/setup-admin-key.txt（首个管理员设置后失效）');
  } catch (err) {
    // 密钥写失败不阻断启动：此时 env 未设置，/admin 自提端点按「未配 key」逻辑
    // 仅允许服务器本机访问兜底（见 admin.ts 控制器）。
    strapi.log.error(`[setup-admin] key rotation failed: ${err}`);
  }
}
