import type { AppEnv, MailFormat } from '@workfluence/shared';

/**
 * 사내 메일 API에 보내는 요청 (A등급, P18_설계서_Mail C절·FR-1900·1902). 모양은 **사용자가 준 설명 그대로**다(`docs/prompts/phase17/scope.md`):
 *
 * ```
 * POST {WF_MAIL_API_URL}
 * content-type: application/json; charset=utf-8
 * {WF_MAIL_AUTH_HEADER}: {WF_MAIL_AUTH_VALUE}      둘 다 있을 때만
 * {"subject", "content", "receivers", "sender_name"}
 * ```
 *
 * 현장의 API가 다르면 **이 파일 하나**(와 그 시험)를 고친다(A.1-2). 받는 사람은 한 통에 하나다(A.1-3 — 한 통에 여럿이면 서로의 주소가 드러난다)
 */
/** 메일 서버가 안 받으면 알림 처리가 거기 묶인다 — 시간 제한을 둔다 (T-026의 교훈, FR-1903). 앱과 시험 명령이 같은 값을 쓴다 */
export const MAIL_TIMEOUT_MS = 10_000;

export type MailConfig = { url: string; format: MailFormat; senderName: string; authHeader: string; authValue: string };

/** 보낼 메일 한 통 — 평문과 마크다운을 함께 싣고, 설정의 형식이 고른다 */
export type OutgoingMail = { to: string; subject: string; text: string; markdown: string };

export function mailConfigOf(env: Pick<AppEnv, 'WF_MAIL_API_URL' | 'WF_MAIL_FORMAT' | 'WF_MAIL_SENDER_NAME' | 'WF_MAIL_AUTH_HEADER' | 'WF_MAIL_AUTH_VALUE'>): MailConfig {
  return {
    url: env.WF_MAIL_API_URL,
    format: env.WF_MAIL_FORMAT,
    senderName: env.WF_MAIL_SENDER_NAME,
    authHeader: env.WF_MAIL_AUTH_HEADER,
    authValue: env.WF_MAIL_AUTH_VALUE,
  };
}

export function mailRequest(cfg: MailConfig, mail: OutgoingMail): { url: string; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (cfg.authHeader && cfg.authValue) headers[cfg.authHeader] = cfg.authValue;
  const body = JSON.stringify({
    subject: mail.subject,
    content: cfg.format === 'markdown' ? mail.markdown : mail.text,
    receivers: mail.to,
    sender_name: cfg.senderName,
  });
  return { url: cfg.url, headers, body };
}

/**
 * 남의 글(응답 본문·오류 문장)에서 인증 값을 가린다 — 값 전체와, `Bearer ` 같은 앞말을 뗀 토큰만 (FR-1902). 토큰만 되읊는 서버가 있다
 */
export function hideSecret(text: string, secret: string): string {
  if (!secret) return text;
  const parts = [secret, secret.replace(/^\S+\s+/, '')].filter((p, i, all) => p.length > 0 && all.indexOf(p) === i).sort((a, b) => b.length - a.length);
  return parts.reduce((out, p) => out.split(p).join('***'), text);
}

/** 시험 명령 — 받지 않은 상태 코드마다 무엇을 볼지 (FR-1905). 사내 API 설명: 400 필수 파라미터 누락, 500 메일 발송 오류 */
export function statusHint(status: number): string {
  if (status === 400) return '필수 값이 빠졌거나 틀렸다(사내 API 설명: 필수 파라미터 누락) — 받는 주소와 WF_MAIL_SENDER_NAME을 본다. 형식과 주소가 맞는지(markdown이면 …/send_markdown)도 본다';
  if (status === 401 || status === 403) return '인증을 받지 않았다 — WF_MAIL_AUTH_HEADER·WF_MAIL_AUTH_VALUE(헤더 이름과 값 전체)를 메일 API 담당에게 받은 대로 적는다';
  if (status === 404 || status === 405) return '그 주소에 보내는 곳이 없다 — WF_MAIL_API_URL을 끝의 /api/v1/email/send(마크다운이면 …/send_markdown)까지 적었는지 본다';
  if (status >= 500) return '메일 서버가 보내지 못했다(사내 API 설명: 메일 발송 오류) — 메일 API 담당에게 그 시각을 알린다';
  return `예상하지 못한 응답 ${status} — 메일 API 담당에게 그 시각과 함께 알린다`;
}

/** 닿지 않은 까닭 — 오류 코드로만 말한다(주소는 싣지 않는다) */
export function failureHint(e: unknown): string {
  if (e instanceof DOMException && e.name === 'TimeoutError') return `${MAIL_TIMEOUT_MS / 1000}초 안에 답이 없다 — 주소·포트가 맞는지, 방화벽이 막는지 본다`;
  const cause = e instanceof Error ? (e.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const message = typeof cause?.message === 'string' ? cause.message : '';
  if (/redirect/i.test(message)) return '메일 API가 다른 주소로 넘겼다 — 넘겨주기는 따르지 않는다(인증 값이 다른 곳으로 가지 않게). 넘겨 준 곳의 주소를 WF_MAIL_API_URL에 적는다';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `호스트 이름을 찾지 못했다 (${code}) — 주소의 호스트를 본다`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code))
    return `인증서를 믿지 못했다 (${code}) — 사내 인증 기관이면 compose 옆 ca/ca.pem에 두고 다시 친다(반입 가이드 10절 ②)`;
  if (code) return `메일 API에 닿지 않는다 (${code}) — 주소·포트와 망을 본다`;
  return '메일 API에 닿지 않는다 — 주소·포트와 망을 본다';
}
