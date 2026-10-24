import type { Core } from '@strapi/strapi';
import crypto from 'crypto';
import path from 'path';
import { errors } from '@strapi/utils';

const { ApplicationError } = errors;

const joinUrl = (base: string, pathname: string) =>
  `${base.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;

const encodeTokenPart = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const decodeTokenPart = <T>(value: string) =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;

export const getDirectUploadSecret = () => {
  const secret =
    process.env.DIRECT_UPLOAD_TOKEN_SECRET ||
    process.env.JWT_SECRET ||
    process.env.APP_KEYS?.split(',')[0]?.trim();

  if (secret) {
    return secret;
  }

  // No real secret configured: refuse to sign tokens with a guessable constant
  // in production (would let anyone forge direct-upload tokens). Only fall back
  // to the dev placeholder outside production.
  if (process.env.NODE_ENV === 'production') {
    throw new ApplicationError(
      'Direct upload secret is not configured (set DIRECT_UPLOAD_TOKEN_SECRET, JWT_SECRET, or APP_KEYS)'
    );
  }
  return 'direct-upload-secret';
};

export const getDirectUploadExpiresInSeconds = () => {
  const raw = Number.parseInt(process.env.DIRECT_UPLOAD_SIGN_EXPIRES || '', 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return 10 * 60;
};

export const signDirectUploadToken = (payload: Record<string, unknown>) => {
  const body = encodeTokenPart(payload);
  const signature = crypto
    .createHmac('sha256', getDirectUploadSecret())
    .update(body)
    .digest('base64url');

  return `${body}.${signature}`;
};

export const verifyDirectUploadToken = <T>(token: string) => {
  const [body, signature] = token.split('.');
  if (!body || !signature) {
    throw new ApplicationError('Invalid direct upload token');
  }

  const expected = crypto
    .createHmac('sha256', getDirectUploadSecret())
    .update(body)
    .digest();

  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new ApplicationError('Direct upload token signature mismatch');
  }

  return decodeTokenPart<T>(body);
};

type S3ProviderOptions = {
  params?: { Bucket?: string; ACL?: string; [k: string]: unknown };
  s3Options?: Record<string, unknown>;
  baseUrl?: string;
  rootPath?: string;
  [k: string]: unknown;
};
type UploadPluginConfig = {
  provider?: string;
  providerOptions?: S3ProviderOptions;
  [k: string]: unknown;
};

export const getS3ProviderConfig = (strapi: Core.Strapi) => {
  const uploadConfig = strapi.config.get('plugin::upload') as UploadPluginConfig | undefined;
  if (uploadConfig?.provider !== '@strapi/provider-upload-aws-s3') {
    throw new ApplicationError('Direct upload only supports the AWS S3 upload provider');
  }

  const providerOptions = uploadConfig?.providerOptions || {};
  const params = providerOptions.params || {};
  const s3Options = providerOptions.s3Options || {};
  const bucket = params.Bucket;

  if (!bucket) {
    throw new ApplicationError('Missing object storage bucket configuration');
  }

  return {
    uploadConfig,
    providerOptions,
    params,
    s3Options,
    bucket,
    acl: params.ACL || 'public-read',
    baseUrl: providerOptions.baseUrl || '',
    rootPath: providerOptions.rootPath || '',
  };
};

export const getObjectKey = (
  file: { hash: string; ext: string; path?: string | null },
  providerOptions: { rootPath?: string | null }
) => {
  const filePrefix = providerOptions.rootPath
    ? `${String(providerOptions.rootPath).replace(/\/+$/, '')}/`
    : '';
  const filePath = file.path ? `${String(file.path).replace(/^\/+|\/+$/g, '')}/` : '';

  return `${filePrefix}${filePath}${file.hash}${file.ext}`;
};

export const getPublicUrl = (
  objectKey: string,
  providerOptions: { baseUrl?: string | null; s3Options?: { endpoint?: string | null }; params?: { Bucket?: string | null } }
) => {
  if (providerOptions.baseUrl) {
    return joinUrl(providerOptions.baseUrl, objectKey);
  }

  const endpoint = providerOptions.s3Options?.endpoint;
  const bucket = providerOptions.params?.Bucket;
  if (!endpoint || !bucket) {
    throw new ApplicationError('Unable to determine public object URL');
  }

  return joinUrl(`${String(endpoint).replace(/\/+$/, '')}/${bucket}`, objectKey);
};

export const normalizeUploadPath = (value: unknown) => {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

  if (!normalized) {
    return '';
  }

  if (normalized.includes('..')) {
    throw new ApplicationError('Upload path cannot contain ".."');
  }

  return normalized;
};

export const normalizeFilename = (value: unknown) => {
  if (typeof value !== 'string') {
    return '';
  }

  return path.basename(value.trim());
};
