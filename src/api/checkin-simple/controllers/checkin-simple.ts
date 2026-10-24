let _config: any = null;
let _records: Record<string, number> = {};

function defaultConfig() { return { enabled: true, reward: 10, periodSeconds: 86400, periodStart: Date.now() }; }

async function loadConfig() {
  if (_config) return _config;
  try {
    const rows = await strapi.db.connection('strapi_core_store_settings').select('value').where({ key: 'checkin_cfg' });
    if (rows.length > 0) { _config = JSON.parse(rows[0].value); _config.periodStart = _config.periodStart || Date.now(); return _config; }
  } catch { /* noop：无配置时走默认值 */ }
  _config = defaultConfig();
  return _config;
}

async function saveConfig(cfg: any) {
  _config = cfg;
  try {
    const val = JSON.stringify(cfg);
    const row = await strapi.db.connection('strapi_core_store_settings').where({ key: 'checkin_cfg' }).first();
    if (row) await strapi.db.connection('strapi_core_store_settings').where({ key: 'checkin_cfg' }).update({ value: val });
    else await strapi.db.connection('strapi_core_store_settings').insert({ key: 'checkin_cfg', value: val, type: 'object' });
  } catch (e) { strapi.log.warn('[checkin] save config failed: ' + e); }
}

async function tickPeriod(cfg: any) {
  const now = Date.now();
  const end = cfg.periodStart + cfg.periodSeconds * 1000;
  if (now >= end) {
    _records = {};
    cfg.periodStart = now;
    try { await strapi.db.connection('strapi_core_store_settings').where({ key: 'checkin_rec' }).del() } catch { /* noop */ }
    return true;
  }
  return false;
}

export default {
  async status(ctx: any) {
    const u = ctx.state?.user; if (!u?.id) return ctx.unauthorized();
    const c = await loadConfig();
    if (await tickPeriod(c)) await saveConfig(c);
    const end = c.periodStart + c.periodSeconds * 1000;
    ctx.send({ enabled: c.enabled, checkedIn: !!_records[u.id], canCheckIn: c.enabled && !_records[u.id], reward: c.reward, periodSeconds: c.periodSeconds, periodStart: c.periodStart, periodEnd: end, timeRemaining: Math.max(0, Math.ceil((end - Date.now()) / 1000)) });
  },

  async checkin(ctx: any) {
    const u = ctx.state?.user; if (!u?.id) return ctx.unauthorized();
    const c = await loadConfig();
    if (await tickPeriod(c)) await saveConfig(c);
    if (!c.enabled) return ctx.badRequest('签到功能已关闭');
    if (_records[u.id]) return ctx.badRequest('本周期已签到');
    const denny = Math.min(9999, ((await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: u.id }, select: ['denny'] }))?.denny || 0) + c.reward);
    await strapi.db.connection('up_users').where({ id: u.id }).update({ denny });
    _records[u.id] = Date.now();
    ctx.send({ ok: true, reward: c.reward, newDenny: denny });
  },

  async getConfig(ctx: any) {
    const u = ctx.state?.user; if (!u?.id) return ctx.unauthorized();
    if (!u.isAdmin) return ctx.forbidden('需要管理员权限');
    const c = await loadConfig();
    await tickPeriod(c);
    ctx.send(c);
  },

  async updateConfig(ctx: any) {
    const u = ctx.state?.user; if (!u?.id) return ctx.unauthorized();
    if (!u.isAdmin) return ctx.forbidden('需要管理员权限');
    const b = ctx.request.body as any;
    const c = await loadConfig();
    if (b.enabled !== undefined) c.enabled = !!b.enabled;
    if (b.reward !== undefined) c.reward = Math.max(1, Math.min(9999, parseInt(b.reward) || 10));
    if (b.periodSeconds !== undefined) { c.periodSeconds = Math.max(60, Math.min(31536000, parseInt(b.periodSeconds) || 86400)); c.periodStart = Date.now(); _records = {}; try { await strapi.db.connection('strapi_core_store_settings').where({ key: 'checkin_rec' }).del() } catch { /* noop */ } }
    await saveConfig(c);
    ctx.send({ ok: true, ...c });
  },
};
