export default {
  async get(ctx: any) {
    try {
      const r = await strapi.db.connection('strapi_core_store_settings').select('value').where({ key: 'tip_ratio' }).first();
      if (r) { const v = JSON.parse(r.value); ctx.send({ ratio: parseInt(v.ratio) || 1 }); return; }
    } catch { /* noop：读取失败回退默认比例 */ }
    ctx.send({ ratio: 1 });
  },
  async update(ctx: any) {
    const u = ctx.state?.user;
    if (!u?.id || !u.isAdmin) return ctx.forbidden('需要管理员权限');
    const ratio = Math.max(0, parseInt(ctx.request.body?.ratio) || 1);
    try {
      const val = JSON.stringify({ ratio });
      const r = await strapi.db.connection('strapi_core_store_settings').where({ key: 'tip_ratio' }).first();
      if (r) await strapi.db.connection('strapi_core_store_settings').where({ key: 'tip_ratio' }).update({ value: val });
      else await strapi.db.connection('strapi_core_store_settings').insert({ key: 'tip_ratio', value: val, type: 'object' });
    } catch { /* noop：保存失败仍按请求值响应 */ }
    ctx.send({ ratio });
  },
};
