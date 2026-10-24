import { randomBytes, createHash } from 'crypto';

function generateKey(len: number): string {
  return randomBytes(len).toString('base64').replace(/[+/=]/g, '').slice(0, len);
}

export default ({ env }) => {
  const adminSecret = env('ADMIN_JWT_SECRET') || generateKey(32);
  const apiSalt = env('API_TOKEN_SALT') || generateKey(32);
  const transferSalt = env('TRANSFER_TOKEN_SALT') || generateKey(32);
  const encryptionKey = env('ENCRYPTION_KEY') || generateKey(32);

  if (!env('ADMIN_JWT_SECRET')) {
    console.log('[admin] ADMIN_JWT_SECRET not set, generated random key');
  }

  return {
    auth: {
      secret: adminSecret,
    },
    apiToken: {
      salt: apiSalt,
    },
    transfer: {
      token: {
        salt: transferSalt,
      },
    },
    secrets: {
      encryptionKey,
    },
    flags: {
      nps: env.bool('FLAG_NPS', false),
      promoteEE: env.bool('FLAG_PROMOTE_EE', false),
    },
  };
};
