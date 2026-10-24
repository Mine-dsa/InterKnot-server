'use strict';

/**
 * 删除冗余且无效的 `unique_favorite_user` 索引（favorites_user_lnk 上）。
 *
 * 它是 (favorite_id, user_id)，与 Strapi 自动建立的 `favorites_user_lnk_uq`
 * 完全重复，且并不能阻止「同一用户对同一文章重复收藏」——因为 (user, article)
 * 两列分处不同 link 表，单表唯一约束无法表达该维度。删除它不损失任何唯一性保证。
 *
 * 幂等：按 information_schema 探测后才操作。仅在 MySQL 执行，其它 client 跳过。
 * down() 会按原样重建，保证可逆。
 */

const TABLE = 'favorites_user_lnk';
const INDEX = 'unique_favorite_user';
const COLS = '(`favorite_id`, `user_id`)';

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
    if (!(await indexExists(knex, TABLE, INDEX))) return;
    await knex.raw(`DROP INDEX \`${INDEX}\` ON \`${TABLE}\``);
  },

  async down(knex) {
    if (!isMysql(knex)) return;
    if (await indexExists(knex, TABLE, INDEX)) return;
    await knex.raw(`CREATE UNIQUE INDEX \`${INDEX}\` ON \`${TABLE}\` ${COLS}`);
  },
};
