'use strict';

/**
 * 一次性迁移脚本：把 draft 行上的 denny_count 同步到 published 行。
 *
 * 背景：giveDennyToArticle 此前缺少 publishedAt 过滤，导致投币计数
 * 写入了 draft 行，而详情接口读取的是 published 行（始终为 0）。
 * 该 bug 已在 PR #25 中修复，此脚本用于修正历史数据。
 *
 * 逻辑：
 *   对每个 documentId，找到 draft 行和 published 行。
 *   若 draft.denny_count > published.denny_count，
 *   则将 published 行的 denny_count 更新为 draft 行的值，
 *   并将 draft 行的 denny_count 同步为相同值（保持一致）。
 *
 * 用法：
 *   node ./scripts/migrate-denny-count.js          # 实际执行
 *   node ./scripts/migrate-denny-count.js --dry    # 仅打印计划，不写库
 */

const ARTICLE_UID = 'api::article.article';
const DRY_RUN = process.argv.includes('--dry') || process.argv.includes('--dry-run');

async function migrate() {
  console.log(`[migrate-denny-count] starting${DRY_RUN ? ' (dry-run)' : ''}...`);

  // 查找所有 draft 行中 denny_count > 0 的文章
  const draftsWithDenny = await strapi.db.query(ARTICLE_UID).findMany({
    where: {
      publishedAt: { $null: true },
      denny_count: { $gt: 0 },
    },
    select: ['id', 'documentId', 'denny_count'],
  });

  if (draftsWithDenny.length === 0) {
    console.log('[migrate-denny-count] no draft rows with denny_count > 0 found. nothing to do.');
    return;
  }

  console.log(`[migrate-denny-count] found ${draftsWithDenny.length} draft row(s) with denny_count > 0`);

  let updated = 0;
  let skipped = 0;

  for (const draft of draftsWithDenny) {
    const { documentId, denny_count: draftCount } = draft;

    // 找到对应的 published 行
    const published = await strapi.db.query(ARTICLE_UID).findOne({
      where: {
        documentId,
        publishedAt: { $notNull: true },
      },
      select: ['id', 'denny_count'],
    });

    if (!published) {
      console.log(`  [skip] documentId=${documentId} — no published row found`);
      skipped++;
      continue;
    }

    const publishedCount = published.denny_count || 0;

    if (draftCount <= publishedCount) {
      console.log(`  [skip] documentId=${documentId} — published(${publishedCount}) >= draft(${draftCount})`);
      skipped++;
      continue;
    }

    console.log(`  [update] documentId=${documentId} — published: ${publishedCount} → ${draftCount}`);

    if (!DRY_RUN) {
      // 更新 published 行
      await strapi.db.query(ARTICLE_UID).update({
        where: { id: published.id },
        data: { denny_count: draftCount },
      });
    }

    updated++;
  }

  console.log(
    `[migrate-denny-count] done. updated=${updated}, skipped=${skipped}${DRY_RUN ? ' (dry-run, no writes)' : ''}`
  );
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    await migrate();
  } finally {
    await app.destroy();
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('[migrate-denny-count] failed:', error);
  process.exit(1);
});
