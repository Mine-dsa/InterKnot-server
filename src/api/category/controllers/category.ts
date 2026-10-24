/**
 *  category controller
 */

import { factories } from '@strapi/strapi';
import { CATEGORY_UID } from '../../../utils/categories';

export default factories.createCoreController(CATEGORY_UID, ({ strapi }) => ({
  /**
   * 前端频道 Tab 用：返回所有「已上架」分区，按 order 升序。
   * 公开只读，结构精简（name/slug/order）。
   */
  async listLite(ctx) {
    const items = await strapi.db.query(CATEGORY_UID).findMany({
      where: { isActive: true },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
      select: ['documentId', 'name', 'slug', 'order', 'adminOnly'],
    });

    ctx.send({
      data: (items || []).map((c: any) => ({
        documentId: c.documentId,
        name: c.name,
        slug: c.slug,
        order: c.order ?? 0,
        adminOnly: c.adminOnly === true,
      })),
    });
  },
}));
