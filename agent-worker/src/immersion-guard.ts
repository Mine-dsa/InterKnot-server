/** 破第四墙 / 元评论 */
const META_NARRATION_RE =
  /游戏内角色|游戏角色|角色设定|官方设定|设定集|剧情设定|(?:基于|属于|与).{0,12}(?:同人|二创|仿写)|同人(?:创作|作品)|二次创作|仿写(?:宣传)?稿|虚构设定|架空创作|并不存在于现实|视频截取|外部视频|拼接素材|粉丝向|fan\s*fic|与.{0,20}设定不符|维基百科|百科词条/i;

/** 用机关「文号/正式通报」验真绳网帖——不符合绳网语境 */
const OFFICIAL_VERIFY_RE =
  /(?:未见|缺少|没有).{0,8}治安局.{0,8}(?:标准|正式)?文号|(?:刑侦)?特勤组.{0,8}(?:正式|官方)?(?:通报|通道|渠道)|建议.{0,12}(?:留意|关注|等待).{0,8}(?:治安局|刑侦特勤组|特勤组).{0,8}(?:正式|后续)?(?:通报|通道)/;

const FALLBACK_RUMOR =
  '根据现有信息，这条帖所述内容暂时无法在绳网内形成可靠交叉印证。发布渠道与表述细节存在疑点，建议先按未证实信息处理，留意后续是否出现管理员认证或多源佐证。';

const FALLBACK_SECURITY =
  '该提醒内容合理。请勿轻信代充、赠送兑换码、陌生链接及索要账号密码等行为；请通过平台认证渠道核实发布者身份，注意保护个人信息与账号安全。';

/** 帖文是否为防诈骗 / 账号安全类通告 */
export function isSecurityAdvisoryPost(text: string): boolean {
  const s = String(text || '');
  if (!s) return false;
  const hasScamTopic =
    /诈骗|防诈骗|谨防|代充|兑换码|账号密码|违规账号|陌生链接|代练|外挂|个人信息/.test(s);
  const hasOfficialTone = /提醒|防范|郑重|官方|绳匠|保护/.test(s);
  return hasScamTopic && hasOfficialTone;
}

export function pickImmersionFallback(postContext?: string): string {
  return isSecurityAdvisoryPost(postContext || '')
    ? FALLBACK_SECURITY
    : FALLBACK_RUMOR;
}

export function guardImmersionReply(
  body: string,
  opts?: { postContext?: string },
): { text: string; rewritten: boolean; reason?: 'meta' | 'official_tone' } {
  const s = String(body || '').trim();
  if (!s) return { text: s, rewritten: false };

  if (META_NARRATION_RE.test(s)) {
    return { text: pickImmersionFallback(opts?.postContext), rewritten: true, reason: 'meta' };
  }

  if (!isSecurityAdvisoryPost(opts?.postContext || '') && OFFICIAL_VERIFY_RE.test(s)) {
    return { text: FALLBACK_RUMOR, rewritten: true, reason: 'official_tone' };
  }

  return { text: s, rewritten: false };
}
