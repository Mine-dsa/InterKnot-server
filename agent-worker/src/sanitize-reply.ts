/**
 * 社区评论/DM 为纯文本展示：去除 Markdown 与残留引用角标。
 */
export function sanitizeCommunityReply(
  raw: string,
  opts?: { maxLength?: number },
): string {
  let s = String(raw || '').trim();
  if (!s) return '';

  s = s.replace(/\[(?:reference|citation|ref|source)[:\s]*\d+\]/gi, '');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/_([^_\n]+)_/g, '$1');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '· ');
  s = s.replace(/^\s*\d+\.\s+/gm, '');

  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();

  const max = opts?.maxLength;
  if (max && s.length > max) {
    s = `${s.slice(0, max - 1)}…`;
  }
  return s;
}
