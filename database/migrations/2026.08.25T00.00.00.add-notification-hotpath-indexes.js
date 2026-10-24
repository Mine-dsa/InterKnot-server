'use strict';

/**
 * 补敲敲/通知热路径索引：
 *   - notifications(created_at, id): 敲敲会话聚合（notification.listConversations）
 *     与单会话消息流（listMessages 的 createdAt+documentId 游标）都按
 *     `createdAt desc` 排序扫描，无索引时深翻页需要 filesort。
 *   - experience_logs(created_at, id): addExp 的日上限统计按
 *     (user, createdAt 范围, action) 查询，created_at 前缀索引可显著收敛扫描量。
 *   - denny_logs(related_type, related_id): 投币去重/流水查询按 related 维度过滤。
 *
 * 幂等：按 information_schema 探测后才创建/删除。仅在 MySQL（生产）执行，
 * 其它 client（如 dev 默认 sqlite）直接跳过。
 */

const INDEXES = [
  { name: 'idx_notifications_created', table: 'notifications', cols: '(`created_at`, `id`)' },
  { name: 'idx_experience_logs_created', table: 'experience_logs', cols: '(`created_at`, `id`)' },
  { name: 'idx_denny_logs_related', table: 'denny_logs', cols: '(`related_type`, `related_id`)' },
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
