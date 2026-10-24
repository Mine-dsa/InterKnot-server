async function loadConfig() {
  try {
    const rows = await strapi.db.connection('strapi_core_store_settings').select('value').where({ key: 'checkin_cfg' });
    if (rows.length > 0) {
      const c = JSON.parse(rows[0].value);
      c.periodStart = c.periodStart || Date.now();
      c.periodSeconds = c.periodSeconds || 86400;
      c.reward = c.reward || 10;
      c.enabled = c.enabled !== false;
      return c;
    }
  } catch { /* noop：无配置时走默认值 */ }
  return { enabled: true, reward: 10, periodSeconds: 86400, periodStart: Date.now() };
}

async function loadRecords(): Promise<Record<number, number>> {
  try {
    const rows = await strapi.db.connection('strapi_core_store_settings').select('value').where({ key: 'checkin_rec' });
    if (rows.length > 0) return JSON.parse(rows[0].value);
  } catch { /* noop：无记录时视为空表 */ }
  return {};
}

async function saveRecords(rec: Record<number, number>) {
  try {
    const val = JSON.stringify(rec);
    const row = await strapi.db.connection('strapi_core_store_settings').where({ key: 'checkin_rec' }).first();
    if (row) await strapi.db.connection('strapi_core_store_settings').where({ key: 'checkin_rec' }).update({ value: val });
    else await strapi.db.connection('strapi_core_store_settings').insert({ key: 'checkin_rec', value: val, type: 'object' });
  } catch (e) { strapi.log.warn('[checkin] save records failed: ' + e); }
}

async function saveConfig(cfg: any) {
  try {
    const val = JSON.stringify(cfg);
    const row = await strapi.db.connection('strapi_core_store_settings').where({ key: 'checkin_cfg' }).first();
    if (row) await strapi.db.connection('strapi_core_store_settings').where({ key: 'checkin_cfg' }).update({ value: val });
    else await strapi.db.connection('strapi_core_store_settings').insert({ key: 'checkin_cfg', value: val, type: 'object' });
  } catch { /* noop：配置保存失败不阻断签到主流程 */ }
}

export default {
  async checkIn(ctx: any) {
    const user = ctx.state?.user;
    if (!user) return ctx.unauthorized();
    const c = await loadConfig();
    const rec = await loadRecords();
    const now = Date.now();
    if (now >= c.periodStart + c.periodSeconds * 1000) {
      Object.keys(rec).forEach(k => delete rec[k]);
      c.periodStart = now;
      await strapi.db.connection('strapi_core_store_settings').where({ key: 'checkin_rec' }).del();
    }
    if (!c.enabled) { ctx.status = 409; ctx.body = { error: { code: 'DISABLED', message: '签到功能已关闭' } }; return; }
    if (rec[user.id]) { ctx.status = 409; ctx.body = { error: { code: 'ALREADY', message: '本周期已签到' } }; return; }
    const denny = Math.min(9999, ((await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: user.id }, select: ['denny'] }))?.denny || 0) + c.reward);
    await strapi.db.connection('up_users').where({ id: user.id }).update({ denny });
    rec[user.id] = now;
    await saveConfig(c);
    await saveRecords(rec);
    ctx.send({ ok: true, reward: c.reward, newDenny: denny });
  },

  async getStatus(ctx: any) {
    const user = ctx.state?.user;
    if (!user) return ctx.unauthorized();
    const c = await loadConfig();
    const rec = await loadRecords();
    const now = Date.now();
    const end = c.periodStart + c.periodSeconds * 1000;
    const expired = now >= end;
    ctx.send({
      enabled: c.enabled, checkedIn: expired ? false : !!rec[user.id],
      canCheckIn: c.enabled && (expired || !rec[user.id]), reward: c.reward,
      timeRemaining: Math.max(0, Math.ceil((end - now) / 1000)),
    });
  },
};
