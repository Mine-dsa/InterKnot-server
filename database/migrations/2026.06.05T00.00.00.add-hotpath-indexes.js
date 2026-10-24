'use strict';

/**
 * 补两个仍缺失的热点排序索引（其余热点路径已有索引覆盖）：
 *   - articles(bumped_at): 已发布主 feed 按 `bumpedAt:desc` 排序（article 控制器 list）。
 *   - messages(created_at): 私信分页按 `createdAt desc` 游标翻页（message 控制器 list）。
 *
 * 关系型存在性查询（点赞/收藏/投币的 user+article）已由 Strapi 自动建立的
 * link 表 *_ifk 索引覆盖，无需另加；(user, article) 维度的唯一约束在 Strapi 5 的
 * link 表结构下无法用单表约束表达，故 dedup 仍由应用层（lifecycle beforeCreate）保证。
 *
 * 幂等：按 information_schema 探测后才创建/删除。仅在 MySQL（生产）执行，
 * 其它 client（如 dev 默认 sqlite）直接跳过。
 */

const INDEXES = [
  { name: 'idx_articles_bumped', table: 'articles', cols: '(`bumped_at`, `id`)' },
  { name: 'idx_messages_created', table: 'messages', cols: '(`created_at`, `id`)' },
];

const isMysql = (knex) => /mysql/i.test(knex.client?.config?.client || '');

async function indexExists(knex, table, name) {
  const [rows] = await knex.raw(
    'SELECT COUNT(*) AS c FROM information_schema.statistics ' +
      'WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    [table, name],
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  return Number(row?.c || 0) > 0;
}

module.exports = {
  async up(knex) {
    if (!isMysql(knex)) return;
    for (const idx of INDEXES) {
      if (await indexExists(knex, idx.table, idx.name)) continue;
      await knex.raw(`CREATE INDEX \`${idx.name}\` ON \`${idx.table}\` ${idx.cols}`);
    }
  },

  async down(knex) {
    if (!isMysql(knex)) return;
    for (const idx of INDEXES) {
      if (!(await indexExists(knex, idx.table, idx.name))) continue;
      await knex.raw(`DROP INDEX \`${idx.name}\` ON \`${idx.table}\``);
    }
  },
};
