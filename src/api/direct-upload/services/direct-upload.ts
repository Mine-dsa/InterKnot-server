import type { Core } from '@strapi/strapi';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectCannedACL } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { errors } from '@strapi/utils';
import {
  getDirectUploadExpiresInSeconds,
  getObjectKey,
  getPublicUrl,
  getS3ProviderConfig,
  normalizeFilename,
  normalizeUploadPath,
  signDirectUploadToken,
  verifyDirectUploadToken,
} from '../../../utils/direct-upload';
import {
  extractExtension,
  getAllowedExtensionsForMime,
  resolveAllowedMimeTypes,
} from '../../../utils/upload-constraints';

const { ApplicationError } = errors;

const localUploadStore = new Map<string, any>();

const isLocalMode = () => !process.env.QINIU_S3_ENDPOINT || !process.env.QINIU_ACCESS_KEY;

type PreparedUploadToken = {
  exp: number;
  userId: number | null;
  objectKey: string;
  contentHash?: string;
  file: {
    name: string;
    alternativeText?: string | null;
    caption?: string | null;
    folder: number;
    folderPath: string;
    hash: string;
    ext: string;
    mime: string;
    size: number;
    sizeInBytes: number;
    path?: string;
  };
};

const CONTENT_HASH_REGEX = /^[a-f0-9]{64}$/;

const sanitizeContentHash = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return CONTENT_HASH_REGEX.test(normalized) ? normalized : undefined;
};

const findFileByContentHash = async (strapi: Core.Strapi, contentHash: string) => {
  // provider_metadata 是 JSON 列；Strapi v5 的 $contains 会按文本子串匹配，
  // contentHash 是 64 位十六进制，与 JSON 中其他字段不会重叠，足以唯一定位。
  return strapi.db.query('plugin::upload.file').findOne({
    where: {
      provider_metadata: { $contains: `"contentHash":"${contentHash}"` },
    },
  });
};

const createS3Client = (strapi: Core.Strapi) => {
  const { s3Options } = getS3ProviderConfig(strapi);
  return new S3Client(s3Options);
};

const SNIFF_BYTES = 4100;

const readStreamToBuffer = async (stream: any, maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    total += buf.length;
    if (total >= maxBytes) {
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
};

const sniffObjectMime = async (
  client: S3Client,
  bucket: string,
  objectKey: string
): Promise<string | null> => {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Range: `bytes=0-${SNIFF_BYTES - 1}`,
    })
  );
  if (!response.Body) {
    return null;
  }
  const buffer = await readStreamToBuffer(response.Body, SNIFF_BYTES);
  const { fileTypeFromBuffer } = await import('file-type');
  const detected = await fileTypeFromBuffer(buffer);
  return detected?.mime ?? null;
};

const deleteObjectSilently = async (client: S3Client, bucket: string, objectKey: string) => {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[direct-upload] failed to delete invalid object ${objectKey}: ${(error as Error).message}`
    );
  }
};

const sanitizeOptionalText = (value: unknown) => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const sanitizeDimension = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
};

const resolveUserId = (user: unknown): number | null => {
  const id = (user as { id?: unknown } | null | undefined)?.id;
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
    return id;
  }

  if (typeof id === 'string' && id.trim()) {
    const parsed = Number.parseInt(id.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
};

const sanitizeOutput = async (strapi: Core.Strapi, auth: any, data: any) => {
  const schema = strapi.getModel('plugin::upload.file');
  return strapi.contentAPI.sanitize.output(data, schema, { auth });
};

const attachUploaderConnection = async (strapi: Core.Strapi, file: any, uploaderId: number | null) => {
  if (!uploaderId || !file?.id) {
    return file;
  }

  // Strapi v5 的 connect 语义为集合并集，重复连接同一用户不会产生重复记录，
  // 因此无需先查后写，单条 update 即可幂等地把当前用户加入 uploaders 集合。
  const updated = await strapi.db.query('plugin::upload.file').update({
    where: { id: file.id },
    data: { uploaders: { connect: [uploaderId] } },
  });

  return updated ?? file;
};

const validateBasicInput = (strapi: Core.Strapi, body: any) => {
  const filename = normalizeFilename(body?.filename);
  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
  const size =
    typeof body?.size === 'number'
      ? body.size
      : typeof body?.size === 'string'
        ? Number.parseInt(body.size, 10)
        : Number.NaN;

  if (!filename) {
    throw new ApplicationError('filename is required');
  }

  if (!mimeType) {
    throw new ApplicationError('mimeType is required');
  }

  if (!Number.isFinite(size) || size <= 0) {
    throw new ApplicationError('size must be a positive integer');
  }

  const allowedMimeTypes = resolveAllowedMimeTypes();
  if (!allowedMimeTypes.has(mimeType)) {
    throw new ApplicationError('mimeType is not allowed');
  }

  // 防止客户端用 image/* 的 MIME 伪装非图片扩展名（例如 filename=x.bin, mimeType=image/png），
  const filenameExt = extractExtension(filename);
  const allowedExtensions = getAllowedExtensionsForMime(mimeType);
  if (!filenameExt || !allowedExtensions.includes(filenameExt)) {
    throw new ApplicationError('filename extension does not match the allowed image mimeType');
  }

  const sizeLimit = strapi.config.get('plugin::upload.sizeLimit');
  if (Number.isFinite(sizeLimit) && size > sizeLimit) {
    throw new ApplicationError('File exceeds upload size limit');
  }

  return {
    filename,
    mimeType,
    size,
  };
};

// 进程内并发去重缓存：同一 (parentId, name) 在并发场景下避免重复创建子文件夹。
const dateFolderCache = new Map<string, Promise<{ id: number }>>();

const findOrCreateSubfolder = async (
  strapi: Core.Strapi,
  parent: { id: number },
  name: string
) => {
  const cacheKey = `${parent.id}/${name}`;
  const cached = dateFolderCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const task = (async () => {
    const existing = await strapi.db.query('plugin::upload.folder').findOne({
      where: { name, parent: parent.id },
    });
    if (existing) {
      return existing;
    }

    const folderService = strapi.plugin('upload').service('folder');
    try {
      return await folderService.create({ name, parent: parent.id });
    } catch (error) {
      // 兜底：并发竞态导致重复创建时，回退查询已存在的同名子文件夹。
      const retry = await strapi.db.query('plugin::upload.folder').findOne({
        where: { name, parent: parent.id },
      });
      if (retry) {
        return retry;
      }
      throw error;
    }
  })().finally(() => {
    dateFolderCache.delete(cacheKey);
  });

  dateFolderCache.set(cacheKey, task);
  return task;
};

const getDateUploadFolder = async (strapi: Core.Strapi) => {
  const root = await strapi
    .plugin('upload')
    .service('api-upload-folder')
    .getAPIUploadFolder();
  const now = new Date();
  const yearName = String(now.getFullYear());
  const monthName = String(now.getMonth() + 1).padStart(2, '0');
  const yearFolder = await findOrCreateSubfolder(strapi, root, yearName);
  const monthFolder = await findOrCreateSubfolder(strapi, yearFolder, monthName);
  return { folder: monthFolder, datePath: `${yearName}/${monthName}` };
};

const getPreparedFileData = async (strapi: Core.Strapi, body: any) => {
  const { filename, mimeType, size } = validateBasicInput(strapi, body);
  const uploadPath = normalizeUploadPath(body?.path);
  const { folder: dateFolder, datePath } = await getDateUploadFolder(strapi);
  const uploadService = strapi.plugin('upload').service('upload');
  const fileInfo = {
    name: sanitizeOptionalText(body?.fileInfo?.name),
    alternativeText: sanitizeOptionalText(body?.fileInfo?.alternativeText),
    caption: sanitizeOptionalText(body?.fileInfo?.caption),
    folder: dateFolder.id,
  };

  return uploadService.formatFileInfo(
    { filename, type: mimeType, size },
    fileInfo,
    { path: uploadPath || datePath }
  );
};

const buildPersistedFileEntity = (
  strapi: Core.Strapi,
  token: PreparedUploadToken,
  body: any,
  uploaderId: number | null
) => {
  const width = sanitizeDimension(body?.width);
  const height = sanitizeDimension(body?.height);
  const { uploadConfig, providerOptions } = getS3ProviderConfig(strapi);
  const publicUrl = getPublicUrl(token.objectKey, providerOptions);

  const providerMetadata: Record<string, unknown> = {
    objectKey: token.objectKey,
    directUpload: true,
  };

  if (token.contentHash) {
    providerMetadata.contentHash = token.contentHash;
  }

  const entity: Record<string, unknown> = {
    name: token.file.name,
    alternativeText: token.file.alternativeText,
    caption: token.file.caption,
    folder: token.file.folder,
    folderPath: token.file.folderPath,
    hash: token.file.hash,
    ext: token.file.ext,
    mime: token.file.mime,
    size: token.file.size,
    url: publicUrl,
    provider: uploadConfig.provider,
    provider_metadata: providerMetadata,
  };

  if (uploaderId) {
    // 多对多关系，使用数组写入；Strapi v5 会建立 link-table 记录
    entity.uploaders = [uploaderId];
  }

  if (typeof width === 'number') {
    entity.width = width;
  }

  if (typeof height === 'number') {
    entity.height = height;
  }

  return entity;
};

export default ({ strapi }: any) => ({
  async createSignedUpload(body: any, user: any, auth: any) {
    const contentHash = sanitizeContentHash(body?.contentHash);
    const userId = resolveUserId(user);

    if (contentHash) {
      const existing = await findFileByContentHash(strapi, contentHash);
      if (existing) {
        const ownedExisting = await attachUploaderConnection(strapi, existing, userId);
        return { existing: await sanitizeOutput(strapi, auth, ownedExisting) };
      }
    }

    const file = await getPreparedFileData(strapi, body);

    if (isLocalMode()) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresIn = getDirectUploadExpiresInSeconds();

      localUploadStore.set(token, {
        userId,
        contentHash,
        file: {
          name: file.name,
          alternativeText: file.alternativeText,
          caption: file.caption,
          folder: file.folder,
          folderPath: file.folderPath,
          hash: file.hash,
          ext: file.ext,
          mime: file.mime,
          size: file.size,
          sizeInBytes: file.sizeInBytes,
          path: file.path,
        },
        expiresAt: Date.now() + expiresIn * 1000,
      });

      const uploadUrl = `/api/direct-upload/upload-file/${token}`;
      return {
        uploadUrl,
        uploadToken: token,
        method: 'PUT',
        objectKey: token,
        publicUrl: `/uploads/${file.hash}${file.ext}`,
        headers: { 'Content-Type': file.mime },
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
    }

    const { bucket, acl, providerOptions } = getS3ProviderConfig(strapi);
    const objectKey = getObjectKey(file, providerOptions);
    const expiresIn = getDirectUploadExpiresInSeconds();
    const client = createS3Client(strapi);

    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentType: file.mime,
        ACL: acl as ObjectCannedACL,
      }),
      { expiresIn }
    );

    const now = Math.floor(Date.now() / 1000);
    const uploadToken = signDirectUploadToken({
      exp: now + expiresIn,
      userId,
      objectKey,
      contentHash,
      file: {
        name: file.name,
        alternativeText: file.alternativeText,
        caption: file.caption,
        folder: file.folder,
        folderPath: file.folderPath,
        hash: file.hash,
        ext: file.ext,
        mime: file.mime,
        size: file.size,
        sizeInBytes: file.sizeInBytes,
        path: file.path,
      },
    });

    return {
      uploadUrl,
      uploadToken,
      method: 'PUT',
      objectKey,
      publicUrl: getPublicUrl(objectKey, providerOptions),
      headers: {
        'Content-Type': file.mime,
      },
      expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
    };
  },

  async completeDirectUpload(body: any, user: any, auth: any) {
    if (isLocalMode()) {
      const tokenValue = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';
      if (!tokenValue) throw new ApplicationError('uploadToken is required');

      const meta = localUploadStore.get(tokenValue);
      if (!meta) throw new ApplicationError('Upload token not found or expired');
      if (Date.now() > meta.expiresAt) { localUploadStore.delete(tokenValue); throw new ApplicationError('Upload token expired'); }

      const userId = resolveUserId(user);
      if (meta.userId && meta.userId !== userId) throw new ApplicationError('Token does not belong to current user');

      if (!meta.uploadedFilePath) throw new ApplicationError('File not uploaded yet');

      const uploadDir = path.join(process.cwd(), 'public', 'uploads');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

      const persisted = await strapi.db.query('plugin::upload.file').create({
        data: {
          name: meta.file.name,
          alternativeText: meta.file.alternativeText || null,
          caption: meta.file.caption || null,
          hash: meta.file.hash,
          ext: meta.file.ext,
          mime: meta.file.mime,
          size: meta.file.sizeInBytes / 1000,
          url: `/uploads/${meta.file.hash}${meta.file.ext}`,
          provider: 'local',
          folder: meta.file.folder || null,
          folderPath: meta.file.folderPath || '',
        },
      });

      if (userId) {
        try {
          await attachUploaderConnection(strapi, persisted, userId);
        } catch { /* noop：上传者关系挂接失败不阻断文件落地 */ }
      }

      try {
        const srcPath = path.join(uploadDir, `${meta.file.hash}${meta.file.ext}`);
        const smallPath = path.join(uploadDir, `${meta.file.hash}${meta.file.ext}-small.webp`);
        if (fs.existsSync(srcPath) && !fs.existsSync(smallPath)) {
          await sharp(srcPath).resize(128, 128, { fit: 'cover' }).webp({ quality: 80 }).toFile(smallPath);
        }
      } catch { /* noop：缩略图生成失败不影响原图 */ }

      localUploadStore.delete(tokenValue);
      return sanitizeOutput(strapi, auth, persisted);
    }

    const tokenValue = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';
    if (!tokenValue) {
      throw new ApplicationError('uploadToken is required');
    }

    const token = verifyDirectUploadToken<PreparedUploadToken>(tokenValue);
    const now = Math.floor(Date.now() / 1000);
    if (!token.exp || now > token.exp) {
      throw new ApplicationError('Direct upload token has expired');
    }

    const userId = resolveUserId(user);
    if (token.userId && token.userId !== userId) {
      throw new ApplicationError('Direct upload token does not belong to the current user');
    }

    // 优先按 contentHash 做内容级去重（覆盖 sign → complete 之间的并发竞态）。
    if (token.contentHash) {
      const sameContent = await findFileByContentHash(strapi, token.contentHash);
      if (sameContent) {
        return sanitizeOutput(strapi, auth, await attachUploaderConnection(strapi, sameContent, userId));
      }
    }

    const existing = await strapi.db.query('plugin::upload.file').findOne({
      where: {
        hash: token.file.hash,
        ext: token.file.ext,
      },
    });

    if (existing) {
      return sanitizeOutput(strapi, auth, await attachUploaderConnection(strapi, existing, userId));
    }

    const { bucket } = getS3ProviderConfig(strapi);
    const client = createS3Client(strapi);
    const headObject = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: token.objectKey,
      })
    );

    const actualSize = Number(headObject.ContentLength || 0);
    if (actualSize <= 0) {
      throw new ApplicationError('Uploaded object is empty or not visible yet');
    }

    if (actualSize !== token.file.sizeInBytes) {
      throw new ApplicationError('Uploaded object size does not match the signed request');
    }

    const contentType = String(headObject.ContentType || '').toLowerCase();
    if (contentType && contentType !== token.file.mime) {
      throw new ApplicationError('Uploaded object MIME type does not match the signed request');
    }

    // 内容嗅探：S3 上 ContentType 是签名时由后端写死的，无法证明对象真实内容，
    // 这里读前 ~4KB 用 magic bytes 做最终把关；不通过则删除孤儿对象。
    const detectedMime = await sniffObjectMime(client, bucket, token.objectKey);
    const allowedMimeTypes = resolveAllowedMimeTypes();
    if (!detectedMime || !allowedMimeTypes.has(detectedMime) || detectedMime !== token.file.mime) {
      await deleteObjectSilently(client, bucket, token.objectKey);
      throw new ApplicationError(
        detectedMime
          ? 'Uploaded object content does not match the declared image mimeType'
          : 'Uploaded object content type could not be detected'
      );
    }

    const persisted = await strapi.db.query('plugin::upload.file').create({
      data: buildPersistedFileEntity(strapi, token, body, userId),
    });

    return sanitizeOutput(strapi, auth, persisted);
  },

  async processLocalUpload(token: string, ctx: any) {
    const meta = localUploadStore.get(token);
    if (!meta) throw new ApplicationError('Upload token not found or expired');
    if (Date.now() > meta.expiresAt) { localUploadStore.delete(token); throw new ApplicationError('Upload token expired'); }

    // ── 校验基准：签名时已通过 validateBasicInput 的声明值 ──
    // declaredSize ≤ sizeLimit(30MB)、mime 在白名单、扩展名匹配（见 sign 流程）。
    const declaredSize = meta.file.sizeInBytes;
    const declaredMime = meta.file.mime;
    const sizeLimit = strapi.config.get('plugin::upload.sizeLimit');
    const hardCap = Math.min(
      Number.isFinite(sizeLimit) ? Number(sizeLimit) : Number.POSITIVE_INFINITY,
      50 * 1024 * 1024 // 绝对上限兜底：即使 sizeLimit 被配置得离谱也不允许超过 50MB
    );

    // 流式收集，边收边卡上限：超过声明大小或绝对上限立即中止，
    // 防止任意大 body 全量缓冲进内存（内存耗尽 DoS）。
    const chunks: Buffer[] = [];
    let received = 0;
    let aborted: Error | null = null;
    const req = ctx.req;
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (received > declaredSize || received > hardCap) {
          aborted = new ApplicationError(
            'Uploaded body exceeds the signed size request'
          );
          try { req.destroy(); } catch { /* noop */ }
          reject(aborted);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve());
      req.on('error', reject);
    });

    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) throw new ApplicationError('Uploaded file is empty');

    // 大小必须与签名声明的 sizeInBytes 完全一致（对齐 S3 complete 路径的校验）
    if (buffer.length !== declaredSize) {
      throw new ApplicationError('Uploaded file size does not match the signed request');
    }

    // 魔数嗅探（与 S3 路径 sniffObjectMime 同库同判定）：
    // 检测类型必须在白名单内且与声明 MIME 一致，否则拒绝（不落盘）。
    const { fileTypeFromBuffer } = await import('file-type');
    const detected = await fileTypeFromBuffer(buffer);
    const detectedMime = detected?.mime ?? null;
    const allowedMimeTypes = resolveAllowedMimeTypes();
    if (!detectedMime || !allowedMimeTypes.has(detectedMime) || detectedMime !== declaredMime) {
      throw new ApplicationError(
        detectedMime
          ? 'Uploaded file content does not match the declared image mimeType'
          : 'Uploaded file content type could not be detected'
      );
    }

    const uploadDir = path.join(process.cwd(), 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const destPath = path.join(uploadDir, `${meta.file.hash}${meta.file.ext}`);
    fs.writeFileSync(destPath, buffer);

    meta.uploadedFilePath = destPath;
    meta.uploadedSize = buffer.length;
    localUploadStore.set(token, meta);

    return { ok: true, size: buffer.length };
  },
});
