import type { Context } from 'koa';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { resolveAllowedMimeTypes } from '../utils/upload-constraints';

const readFirstBytes = async (filepath: string, maxBytes: number) => {
  const fileHandle = await fs.promises.open(filepath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
};

const collectFiles = (value: any, files: any[]) => {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, files);
    return;
  }
  if (typeof value === 'object') {
    if (value.filepath || value.path) {
      files.push(value);
      return;
    }
    for (const item of Object.values(value)) {
      collectFiles(item, files);
    }
  }
};

export default (config: any = {}) => {
  const allowedMimeTypes = resolveAllowedMimeTypes(config);
  const maxBytesToCheck =
    typeof config.maxBytesToCheck === 'number' && config.maxBytesToCheck > 0
      ? config.maxBytesToCheck
      : 4100;

  return async (ctx: Context, next: () => Promise<void>) => {
    const sendBadRequest = (code: string, message: string, details?: Record<string, unknown>) => {
      ctx.status = 400;
      ctx.body = {
        error: {
          code,
          message,
          details: details || undefined,
        },
      };
    };

    const pathName = ctx?.request?.path || '';
    const method = (ctx?.request?.method || '').toUpperCase();
    const isUploadRoute =
      (pathName.startsWith('/api/upload') || pathName.startsWith('/upload')) &&
      (method === 'POST' || method === 'PUT');

    if (!isUploadRoute) {
      await next();
      return;
    }

    const files: any[] = [];
    collectFiles(ctx?.request?.files, files);

    if (files.length === 0) {
      await next();
      return;
    }

    for (const file of files) {
      const filepath = file.filepath || file.path;
      if (!filepath) {
        sendBadRequest('UPLOAD_FILEPATH_MISSING', 'Invalid upload file: missing temporary file path.', {
          filename: file.originalFilename || file.name || file.filename || null,
        });
        return;
      }

      const originalName = file.originalFilename || file.name || file.filename || '';
      const ext = path.extname(originalName).toLowerCase().replace('.', '');
      const mimeFromExt = ext ? mime.lookup(ext) || '' : '';
      const reportedMime = String(file.mimetype || file.type || mimeFromExt || '').toLowerCase();

      const buffer = await readFirstBytes(filepath, maxBytesToCheck);
      const { fileTypeFromBuffer } = await import('file-type');
      const detected = await fileTypeFromBuffer(buffer);
      const detectedMime = detected?.mime || null;

      if (!detectedMime) {
        sendBadRequest('UPLOAD_FILETYPE_UNKNOWN', 'Invalid upload file: unable to detect file type.', {
          filename: originalName || null,
        });
        return;
      }

      if (!allowedMimeTypes.has(detectedMime)) {
        sendBadRequest('UPLOAD_MIME_NOT_ALLOWED', 'Invalid upload file: file type is not allowed.', {
          filename: originalName || null,
          detectedMime,
          allowedMimeTypes: Array.from(allowedMimeTypes),
        });
        return;
      }

      if (reportedMime && detectedMime !== reportedMime) {
        sendBadRequest('UPLOAD_MIME_MISMATCH', 'Invalid upload file: reported MIME type does not match detected file type.', {
          filename: originalName || null,
          reportedMime,
          detectedMime,
        });
        return;
      }
    }

    await next();
  };
};
