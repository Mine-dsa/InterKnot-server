/** 与 comment/utils/mention.ts 一致的 token 拼装 */
export const buildMentionToken = (name: string, authorDocumentId: string): string => {
  const safeName = (name || '').slice(0, 40).replace(/[\[\]\n]/g, '');
  return `@[${safeName}](${authorDocumentId})`;
};

export const prependMentionToBody = (
  displayName: string,
  authorDocumentId: string,
  body: string,
): string => {
  const token = buildMentionToken(displayName, authorDocumentId);
  const trimmed = (body || '').trim();
  return trimmed ? `${token}\n${trimmed}` : token;
};
