import type { Context } from 'koa';
import { getClientIp } from '../../../utils/common';

export default {
  async status(ctx: Context) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized();

    const result = await strapi.service('api::exam.exam').getStatus(user.id);
    ctx.send(result);
  },

  async start(ctx: Context) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized();

    const result = await strapi
      .service('api::exam.exam')
      .startExam(user.id, getClientIp(ctx) || undefined);
    ctx.send(result);
  },

  async submit(ctx: Context) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized();

    const result = await strapi.service('api::exam.exam').submitExam(user.id, ctx.request?.body);
    ctx.send(result);
  },
};
