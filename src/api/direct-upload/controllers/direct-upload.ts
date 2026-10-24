import type { Context } from 'koa';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

export default {
  async sign(ctx: Context) {
    const result = await strapi
      .service('api::direct-upload.direct-upload')
      .createSignedUpload(ctx.request?.body, ctx.state?.user, ctx.state?.auth);

    ctx.body = { data: result };
  },

  async complete(ctx: Context) {
    const file = await strapi
      .service('api::direct-upload.direct-upload')
      .completeDirectUpload(ctx.request?.body, ctx.state?.user, ctx.state?.auth);

    ctx.status = 201;
    ctx.body = { data: file };
  },

  async localUpload(ctx: Context) {
    const { token } = ctx.params;
    const service = strapi.service('api::direct-upload.direct-upload');
    const result = await service.processLocalUpload(token, ctx);
    ctx.status = 201;
    ctx.body = { data: result };
  },
};
