import { randomBytes } from 'crypto';
import cronTasks from './cron-tasks';

export default ({ env }) => {
  const appKeys = env.array('APP_KEYS');
  const keys = appKeys && appKeys.length > 0 ? appKeys : [randomBytes(32).toString('base64')];

  if (!appKeys || appKeys.length === 0) {
    console.log('[server] APP_KEYS not set, generated random key');
  }

  return {
    host: env('HOST', '0.0.0.0'),
    port: env.int('PORT', 1337),
    proxy: true,

    cron: {
      enabled: true,
      tasks: cronTasks,
    },

    app: {
      keys,
    },
  };
};
