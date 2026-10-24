export const DEFAULT_ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
];

// 每个允许的 MIME 对应的合法扩展名集合（小写，不含点）。
export const DEFAULT_MIME_TO_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/avif': ['avif'],
};

export const resolveAllowedMimeTypes = (config: any = {}) =>
  new Set<string>(
    Array.isArray(config.allowedMimeTypes) && config.allowedMimeTypes.length > 0
      ? config.allowedMimeTypes
      : DEFAULT_ALLOWED_IMAGE_MIME_TYPES
  );

export const getAllowedExtensionsForMime = (mimeType: string): string[] =>
  DEFAULT_MIME_TO_EXTENSIONS[mimeType] ?? [];

export const extractExtension = (filename: string): string => {
  const idx = filename.lastIndexOf('.');
  if (idx < 0 || idx === filename.length - 1) {
    return '';
  }
  return filename.slice(idx + 1).toLowerCase();
};
