import type { LifecycleEvent } from '../../../../types/strapi';
import { collectMentionedDocumentIds, expandPlainMentions } from '../../utils/mention';
import { updateLikesCount, removeUnreadLikeNotification } from '../../../like/content-types/like/lifecycles';
import { maybeEnqueueCommentAgentJob } from '../../../../utils/agent/triggers';

export default {
  async beforeCreate(event: LifecycleEvent) {
    // 裸 @username 自动展开为 @[name](docId) token，让用户即便不从下拉里
    // 选候选也能正确触发 mention 链路（用户名唯一→可逆解析）。
    // 写入数据库前完成，下游 notifyMentions / 前端渲染都拿到规范化串。
    const data = event?.params?.data;
    if (data && typeof data.content === 'string') {
      try {
        data.content = await expandPlainMentions(data.content, strapi);
      } catch (err) {
        // 展开失败不阻塞评论提交——保持原文写入即可
        strapi.log?.warn?.('[mention] expandPlainMentions(create) failed', err as Error);
      }
    }
  },
  async beforeUpdate(event: LifecycleEvent) {
    event.state = event.state || {};
    event.state.previousArticleId = await findCommentArticleId(event?.params?.where);
    // 编辑评论时同样展开裸 @username。当前评论编辑能力可能未上线，
    // 但 hook 已挂上，未来开放编辑时无需再回头处理。
    const data = event?.params?.data;
    if (data && typeof data.content === 'string') {
      try {
        data.content = await expandPlainMentions(data.content, strapi);
      } catch (err) {
        strapi.log?.warn?.('[mention] expandPlainMentions(update) failed', err as Error);
      }
    }
  },
  async beforeDelete(event: LifecycleEvent) {
    event.state = event.state || {};
    event.state.previousArticleId = await findCommentArticleId(event?.params?.where);
    // 删除前先记下 comment 主键，afterDelete 里据此级联清理 notifications。
    // 用 select 而不是再次 populate，因为这里只需要 id。
    const commentId = await findCommentId(event?.params?.where);
    event.state.previousCommentId = commentId;
    // 同时把所有后代评论 id 也提前查出来——afterDelete 里要级联删除它们。
    // Strapi v5 的 oneToMany 关系默认 SET NULL，不会自动删 children；如果不
    // 处理，子评论的 parent 会变 null 漂回顶层评论列表，造成数据漂移。
    event.state.descendantCommentIds = Number.isInteger(commentId)
      ? await collectDescendantCommentIds(commentId as number)
      : [];
  },
  async afterCreate(event: LifecycleEvent) {
    await notifyOnCommentCreate(event);
    await notifyMentions(event);
    await updateArticleCommentCount(event);
    await bumpArticleBumpedAt(event);
    await addCommentExp(event);
    const commentId = event?.result?.id;
    if (Number.isInteger(commentId)) {
      setImmediate(() => {
        maybeEnqueueCommentAgentJob(strapi, commentId).catch((err) => {
          strapi.log?.error?.('[agent] maybeEnqueueCommentAgentJob unhandled', err);
        });
      });
    }
  },
  async afterUpdate(event: LifecycleEvent) {
    await updateArticleCommentCount(event);
  },
  async afterDelete(event: LifecycleEvent) {
    // 顺序很重要：
    // 1) 先把后代评论及其衍生数据（likes / notifications）一并清掉，
    //    防止它们的 parent 被 SET NULL 后漂回顶层列表。
    // 2) 再让 article.commentscount 重算（descendant 已删，count 自然准）。
    // 3) 最后清当前被删评论自己的 notifications（like / mention / comment / reply）。
    await cascadeDeleteCommentDescendants(event);
    await updateArticleCommentCount(event);
    await cascadeDeleteCommentNotifications(event);
  },
};

async function loadCommentWithRelations(commentId: number) {
  return strapi.db.query("api::comment.comment").findOne({
    where: { id: commentId },
    populate: {
      author: {
        populate: { user: true },
      },
      article: {
        populate: {
          author: {
            populate: { user: true },
          },
        },
      },
      parent: {
        populate: {
          author: {
            populate: { user: true },
          },
        },
      },
    },
  });
}

async function notifyOnCommentCreate(event: LifecycleEvent) {
  const { result } = event;

  const comment: any = await loadCommentWithRelations(result.id);

  const senderId = comment.author?.user?.id;
  if (!senderId) return;

  // 匿名评论不发通知；被评论/被回复的目标是匿名的也不发（防止泄露匿名作者身份）
  if (comment.isAnonymous) return;
  if (comment.article?.isAnonymous) return;
  if (comment.parent?.isAnonymous) return;

  let recipientId: number | null = null;
  let type: "comment" | "reply" = "comment";

  // ✅ 回复评论
  if (comment.parent) {
    recipientId = comment.parent.author?.user?.id ?? null;
    type = "reply";
  }
  // ✅ 评论帖子
  else if (comment.article) {
    recipientId = comment.article.author?.user?.id ?? null;
    type = "comment";
  }

  if (!recipientId) return;

  // ✅ 自己不给自己发通知
  if (recipientId === senderId) return;

  await strapi.db.query("api::notification.notification").create({
    data: {
      type,
      recipient: recipientId,
      sender: senderId,
      Article: comment.article?.id,
      Comment: comment.id,
      isRead: false,
    },
  });
}

async function updateArticleCommentCount(event: LifecycleEvent) {
  const articleIds = await collectAffectedArticleIds(event);
  await syncArticleCommentCounts(articleIds);
}

async function collectAffectedArticleIds(event: LifecycleEvent) {
  const { result, params, state } = event || {};
  const articleIds = new Set<number | string>();

  const pushArticleId = (value: any) => {
    const articleId = extractArticleId(value);
    if (articleId) {
      articleIds.add(articleId);
    }
  };

  pushArticleId(state?.previousArticleId);
  pushArticleId(result?.article);
  pushArticleId(params?.data?.article);
  pushArticleId(params?.where?.article);

  if (articleIds.size === 0) {
    const currentArticleId = await findCommentArticleId(
      result?.id
        ? { id: result.id }
        : result?.documentId
          ? { documentId: result.documentId }
          : params?.where
    );

    pushArticleId(currentArticleId);
  }

  return Array.from(articleIds);
}

function extractArticleId(value: any): number | string | null {
  if (!value) return null;

  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    if (value.id) return value.id;
    if (Array.isArray(value.connect) && value.connect[0]?.id) {
      return value.connect[0].id;
    }
    if (Array.isArray(value.set) && value.set[0]?.id) {
      return value.set[0].id;
    }
  }

  return null;
}

async function findCommentArticleId(where: any) {
  if (!where) return null;

  const comment = await strapi.db.query('api::comment.comment').findOne({
    where,
    populate: {
      article: {
        select: ['id'],
      },
    },
  });

  return comment?.article?.id ?? null;
}

async function syncArticleCommentCounts(articleIds: Array<number | string>) {
  const uniqueArticleIds = Array.from(
    new Set(articleIds.filter((articleId) => articleId !== null && articleId !== undefined))
  );

  for (const articleId of uniqueArticleIds) {
    // Resolve to numeric id – articleId may be a numeric id or a documentId string
    const isNumeric = typeof articleId === 'number' || /^\d+$/.test(String(articleId));
    const article = await strapi.db.query('api::article.article').findOne({
      where: isNumeric ? { id: articleId } : { documentId: articleId },
      select: ['id'],
    });
    if (!article) {
      strapi.log.warn(`[Counter] Article not found for id/documentId: ${articleId}`);
      continue;
    }

    const count = await strapi.db.query('api::comment.comment').count({
      where: {
        article: article.id,
      },
    });

    await strapi.db.query('api::article.article').update({
      where: { id: article.id },
      data: { commentscount: count },
    });

    strapi.log.info(`[Counter] Article ${article.id} updated: ${count} comments.`);
  }
}

/**
 * Discourse 风格 bump：新评论将文章的 bumpedAt 更新为当前时间，
 * 使活跃讨论自然上浮到推流顶部。
 * 失败不阻断评论写入流程。
 */
async function bumpArticleBumpedAt(event: LifecycleEvent) {
  try {
    const { result } = event;
    if (!result?.id) return;

    const comment: any = await strapi.db.query('api::comment.comment').findOne({
      where: { id: result.id },
      select: ['id'],
      populate: { article: { select: ['id'] } },
    });

    const articleId = comment?.article?.id;
    if (!articleId) return;

    await strapi.db.query('api::article.article').update({
      where: { id: articleId },
      data: { bumpedAt: new Date().toISOString() },
    });
  } catch (err) {
    strapi.log?.warn?.('[bumpedAt] failed to bump article on comment create', err as Error);
  }
}

async function addCommentExp(event: LifecycleEvent) {
  const { result } = event;
  
  try {
      // Use require for lazy loading and to avoid top-level import issues
      const { addExp } = require('../../../../utils/level');

      const comment: any = await loadCommentWithRelations(result.id);

      const senderId = comment?.author?.user?.id;

      const recipientId = comment?.parent?.author?.user?.id || comment?.article?.author?.user?.id;

      const tasks = [];

      if (senderId) {
          tasks.push(
            addExp(strapi, senderId, 3, 'create_comment', 'api::comment.comment', result.id)
          );
      }

      if (senderId && recipientId && senderId !== recipientId) {
          tasks.push(
            addExp(
              strapi,
              recipientId,
              1,
              'comment_received',
              'api::comment.comment',
              `receive:${senderId}:${result.id}`
            )
          );
      }

      await Promise.all(tasks);
  } catch (err) {
      strapi.log.error('Error adding exp for comment creation:', err);
  }
}

/**
 * 评论里 @ 提及的通知派发。
 *
 * 业务规则：
 * 1. 匿名评论里的 @ 不发通知（防止匿名身份骚扰）。
 * 2. @ 自己跳过。
 * 3. 已经会从 notifyOnCommentCreate 收到 reply/comment 通知的人跳过——
 *    即被回复的父评论作者、或者被评论帖子的作者。
 *    避免同一行为给同一收件人产生两条通知。
 * 4. 单评论 @ 数量上限 10，防止滥用。
 * 5. 通知被 mention 用户的 SSE / 缓存失效，由
 *    `notification.lifecycles.afterCreate` 自动完成（每条 create 都会触发）。
 *    本函数无需自行 publish / invalidate。
 *
 * 失败不抛错——@ 没发出去不应阻断评论本身的写入流程。
 */
async function notifyMentions(event: LifecycleEvent) {
  try {
    const { result } = event;
    if (!result?.id) return;

    const comment: any = await loadCommentWithRelations(result.id);
    if (!comment) return;

    // 匿名相关评论：跳过 @ 通知派发
    if (comment.isAnonymous) return;
    if (comment.article?.isAnonymous) return;
    if (comment.parent?.isAnonymous) return;

    const senderUserId: number | undefined = comment.author?.user?.id;
    if (!Number.isInteger(senderUserId)) return;

    const documentIds = collectMentionedDocumentIds(comment.content || '', 10);
    if (documentIds.length === 0) return;

    // 已经会通过 notifyOnCommentCreate 收到 reply/comment 的用户：跳过避免双通知
    const primaryRecipientId: number | null = comment.parent
      ? (comment.parent.author?.user?.id ?? null)
      : (comment.article?.author?.user?.id ?? null);

    // 解析 documentId → user.id；过滤封禁 / 没绑定 user 的 author
    const authors = await strapi.db.query('api::author.author').findMany({
      where: { documentId: { $in: documentIds } },
      select: ['id', 'documentId'],
      populate: { user: { select: ['id', 'blocked'] } },
    });

    const articleId: number | null = comment.article?.id ?? null;
    const commentId: number = comment.id;

    const tasks: Promise<unknown>[] = [];
    const dispatchedRecipients = new Set<number>();

    for (const author of authors || []) {
      const recipientId: number | undefined = author?.user?.id;
      if (!Number.isInteger(recipientId)) continue;
      if (author?.user?.blocked === true) continue;
      if (recipientId === senderUserId) continue;
      if (recipientId === primaryRecipientId) continue;
      if (dispatchedRecipients.has(recipientId)) continue;
      dispatchedRecipients.add(recipientId);

      tasks.push(
        strapi.db.query('api::notification.notification').create({
          data: {
            type: 'mention',
            recipient: recipientId,
            sender: senderUserId,
            Article: articleId,
            Comment: commentId,
            isRead: false,
          },
        }),
      );
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  } catch (err) {
    strapi.log?.warn?.('[mention] notifyMentions failed', err as Error);
  }
}

/**
 * 评论被删除时，级联清理由该评论触发的所有 notifications。
 *
 * 触发的通知种类（schema：notification.Comment 关系）：
 *   - comment / reply / mention：发件人对评论本身写入触发
 *   - like：用户点赞了该评论
 *
 * 不会动 Article 维度的通知（like-on-article / favorite），那些和评论无关。
 *
 * 注：删除 notification 不会触发 notification.lifecycles 的 afterCreate，
 * 但收件人的会话缓存依然需要失效——这里直接删 redis 缓存兜底。
 */
async function cascadeDeleteCommentNotifications(event: LifecycleEvent) {
  try {
    const commentId = event?.state?.previousCommentId;
    if (!Number.isInteger(commentId)) return;

    // 先查 recipient 列表用于失效缓存，再批量删
    const affected = await strapi.db
      .query('api::notification.notification')
      .findMany({
        where: { Comment: { id: commentId } },
        select: ['id'],
        populate: { recipient: { select: ['id'] } },
      });

    if (!affected.length) return;

    const recipientIds = Array.from(
      new Set(
        affected
          .map((n: any) => n?.recipient?.id)
          .filter((id: unknown): id is number => Number.isInteger(id)),
      ),
    );

    // 已通过 findMany 拿到 id 列表，直接按 id 删除，
    // 避免 deleteMany + 嵌套关联条件（Comment: { id }）可能不工作的问题。
    const notifIds = affected.map((n: any) => n.id).filter((id: unknown): id is number => Number.isInteger(id));
    if (notifIds.length > 0) {
      await strapi.db.query('api::notification.notification').deleteMany({
        where: { id: { $in: notifIds } },
      });
    }

    if (recipientIds.length > 0) {
      try {
        const { getRedis } = require('../../../../utils/redis');
        const redis = getRedis();
        await Promise.all([
          ...recipientIds.map((id: number) => redis.del(`knock:conv:${id}`)),
          ...recipientIds.map((id: number) => redis.del(`dm:conv-list:${id}`)),
        ]);
      } catch {
        /* redis 不可用就让 TTL 自然恢复 */
      }
    }
  } catch (err) {
    strapi.log?.warn?.('[mention] cascadeDeleteCommentNotifications failed', err as Error);
  }
}

/**
 * beforeDelete 钩子：从 where 条件里反查 comment.id（params.where 既可能是 numeric id 也可能是 documentId）。
 * 与 findCommentArticleId 同形态，复用 db.query.findOne。
 */
async function findCommentId(where: any): Promise<number | null> {
  if (!where) return null;
  const comment = await strapi.db.query('api::comment.comment').findOne({
    where,
    select: ['id'],
  });
  return comment?.id ?? null;
}

/**
 * BFS 收集 rootId 的所有后代评论 id（不含 root 自己）。
 *
 * 当前 UI 上楼中楼只有一层，但保持递归以兼容未来多级嵌套；同时也能修复
 * 历史数据里因 parent 漂移产生的多级孤儿链。
 */
async function collectDescendantCommentIds(rootId: number): Promise<number[]> {
  const out: number[] = [];
  let frontier: number[] = [rootId];
  // 防御性深度上限：极端深度 / 数据成环时硬中断，避免无限循环
  let safety = 32;
  while (frontier.length > 0 && safety-- > 0) {
    const children = await strapi.db.query('api::comment.comment').findMany({
      where: { parent: { id: { $in: frontier } } },
      select: ['id'],
    });
    const childIds = (children || [])
      .map((c: any) => c?.id)
      .filter((id: unknown): id is number => Number.isInteger(id));
    if (childIds.length === 0) break;
    out.push(...childIds);
    frontier = childIds;
  }
  return out;
}

/**
 * 级联删除被删评论的所有后代评论及其衍生数据（notifications / likes）。
 *
 * 关键点：
 * - 用 `db.query.deleteMany` 而不是 `documents.delete`——前者是底层 ORM
 *   操作，**不会触发 lifecycle 钩子**，否则每个 child 都再次进入 afterDelete
 *   形成重复递归 / 重复 syncArticleCommentCounts。
 * - notifications 收件人会话缓存（knock:conv:<userId>）需要主动失效，否则
 *   敲敲弹窗里仍能看到已删评论的 mention / like 通知 30s。
 * - 失败不抛错——级联清理失败不应让原始 delete 失败回滚。
 */
async function cascadeDeleteCommentDescendants(event: LifecycleEvent) {
  const ids = event?.state?.descendantCommentIds;
  if (!Array.isArray(ids) || ids.length === 0) return;

  try {
    // 1) 先查清理范围内 notifications 的收件人列表（用于事后清 redis）
    const notifications = await strapi.db
      .query('api::notification.notification')
      .findMany({
        where: { Comment: { id: { $in: ids } } },
        select: ['id'],
        populate: { recipient: { select: ['id'] } },
      });
    const recipientIds = Array.from(
      new Set(
        (notifications || [])
          .map((n: any) => n?.recipient?.id)
          .filter((id: unknown): id is number => Number.isInteger(id)),
      ),
    );

    // 2) 删除 notifications（已通过 findMany 拿到 id 列表，按 id 删除避免嵌套关联问题）
    const notifIds = (notifications || [])
      .map((n: any) => n.id)
      .filter((id: unknown): id is number => Number.isInteger(id));
    if (notifIds.length > 0) {
      await strapi.db.query('api::notification.notification').deleteMany({
        where: { id: { $in: notifIds } },
      });
    }

    // 3) 删除孤儿 likes —— db.query.deleteMany 不触发 lifecycle，
    //    需要手动补偿计数器更新和通知清理。
    const orphanLikes = await strapi.db.query('api::like.like').findMany({
      where: { comment: { id: { $in: ids } } },
      populate: {
        user: { select: ['id'] },
        article: {
          select: ['id', 'documentId'],
          populate: {
            author: {
              populate: {
                user: { select: ['id'] },
              },
            },
          },
        },
        comment: {
          select: ['id'],
          populate: {
            author: {
              populate: {
                user: { select: ['id'] },
              },
            },
          },
        },
      },
      limit: 500,
    });
    const likeIds = orphanLikes.map((l: any) => l.id).filter((id: unknown): id is number => Number.isInteger(id));
    if (likeIds.length > 0) {
      await strapi.db.query('api::like.like').deleteMany({
        where: { id: { $in: likeIds } },
      });
      // 手动补偿 lifecycle 中遗漏的清理
      for (const like of orphanLikes) {
        try {
          await Promise.all([
            updateLikesCount(like),
            removeUnreadLikeNotification(like),
          ]);
        } catch (err) {
          strapi.log?.warn?.('[comment] cleanup orphan like failed', err as Error);
        }
      }
    }

    // 4) 最后批量删 comments —— 走 db.query 不再次触发 lifecycle
    await strapi.db.query('api::comment.comment').deleteMany({
      where: { id: { $in: ids } },
    });

    // 5) 失效收件人会话缓存（敲敲 + DM）
    if (recipientIds.length > 0) {
      try {
        const { getRedis } = require('../../../../utils/redis');
        const redis = getRedis();
        await Promise.all([
          ...recipientIds.map((id: number) => redis.del(`knock:conv:${id}`)),
          ...recipientIds.map((id: number) => redis.del(`dm:conv-list:${id}`)),
        ]);
      } catch {
        /* redis 不可用就让 TTL 自然恢复 */
      }
    }
  } catch (err) {
    strapi.log?.warn?.('[comment] cascadeDeleteCommentDescendants failed', err as Error);
  }
}
