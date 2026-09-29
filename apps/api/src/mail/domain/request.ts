import { emailSchema, type AppEnv, type MailFormat } from '@workfluence/shared';

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

/**
 * 줄바꿈·제어 글자(와 그 옆의 빈칸)를 빈칸 하나로 — C1 제어 글자(U+0080~U+009F — U+0085 줄 끝, 터미널이 명령으로 읽는 CSI 등)와 유니코드 줄
 * 구분자(U+2028·U+2029)도 (P18 병합 전 보안 검토 6·코드 리뷰 10). 메일 글(`compose.ts`)의 이름·제목과 시험 명령이 창에 찍는 남의 글도 이것을 지난다
 */
export function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex -- 제어 글자를 지우는 것이 이 함수다
  return s.replace(/ *[\u0000-\u001F\u007F-\u009F\u2028\u2029]+ */g, ' ');
}

/**
 * 받는 사람이 **주소 하나**인가 (A.1-3) — 사내 API의 `receivers`는 쉼표로 이은 여럿을 받는다. 사내 계정의 email은 로그인 때 받아 적는데, 그 값이
 * 쉼표 목록이면 한 사람에게 가야 할 멘션 메일이 여럿에게 간다(P18 병합 전 보안 검토 2). 앞뒤 빈칸도 받지 않는다 — 고쳐 보내지 않고 그 한 통을 실패로 친다
 */
export function isSingleRecipient(to: string): boolean {
  const parsed = emailSchema.safeParse(to);
  return parsed.success && parsed.data === to.toLowerCase() && to === to.trim();
}

export function mailRequest(cfg: MailConfig, mail: OutgoingMail): { url: string; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (cfg.authHeader && cfg.authValue) headers[cfg.authHeader] = cfg.authValue;
  const body = JSON.stringify({
    // **제목은 한 줄이다** — 사내 API가 제목을 메일 머리말(SMTP 헤더)로 옮기면 줄바꿈이 머리말을 끼워 넣는다(P7 C.4.1). 제목에는 부른 사람의
    // 표시 이름이 들고, 사내 계정의 이름은 가입 검사(`displayNameSchema`)를 지나지 않는다 — 보내는 경계 한 곳에서 막는다
    subject: oneLine(mail.subject),
    content: cfg.format === 'markdown' ? mail.markdown : mail.text,
    receivers: mail.to,
    sender_name: cfg.senderName,
  });
  return { url: cfg.url, headers, body };
}

/**
 * 남의 글(응답 본문·오류 문장)에서 인증 값을 가린다 — 값 전체와, `Bearer ` 같은 앞말을 뗀 토큰만 (FR-1902). 토큰만 되읊는 서버가 있다
 */
export function hideSecret(text: string, raw: string): string {
  // 보낼 때 앞뒤 빈칸이 떼어진다 — 서버가 되읊는 값에는 없다(병합 전 보안 검토 4)
  const secret = raw.trim();
  if (!secret) return text;
  // 그대로·`Bearer ` 같은 앞말을 뗀 토큰·그 둘을 JSON으로 이스케이프한 것(`/`는 `\/`로 적는 서버도 있다 — 자체 점검 3)
  const bare = [secret, secret.replace(/^\S+\s+/, '')];
  const json = bare.flatMap((p) => {
    const escaped = JSON.stringify(p).slice(1, -1);
    return [escaped, escaped.replace(/\//g, '\\/')];
  });
  const parts = [...bare, ...json].filter((p, i, all) => p.length > 0 && all.indexOf(p) === i).sort((a, b) => b.length - a.length);
  return parts.reduce((out, p) => out.split(p).join('***'), text);
}

/** 시험 명령 — 받지 않은 상태 코드마다 무엇을 볼지 (FR-1905). 사내 API 설명: 400 필수 파라미터 누락, 500 메일 발송 오류 */
export function statusHint(status: number): string {
  if (status === 400 || status === 422) return '필수 값이 빠졌거나 틀렸다(사내 API 설명: 필수 파라미터 누락) — 받는 주소와 WF_MAIL_SENDER_NAME을 본다. 형식과 주소가 맞는지(markdown이면 …/send_markdown)도 본다';
  if (status === 401 || status === 403) return '인증을 받지 않았다 — WF_MAIL_AUTH_HEADER·WF_MAIL_AUTH_VALUE(헤더 이름과 값 전체)를 메일 API 담당에게 받은 대로 적는다';
  if (status === 404 || status === 405) return '그 주소에 보내는 곳이 없다 — WF_MAIL_API_URL을 끝의 /api/v1/email/send(마크다운이면 …/send_markdown)까지 적었는지 본다';
  if (status >= 500) return '메일 서버가 보내지 못했다(사내 API 설명: 메일 발송 오류) — 메일 API 담당에게 그 시각을 알린다';
  return `예상하지 못한 응답 ${status} — 메일 API 담당에게 그 시각과 함께 알린다`;
}

/** 닿지 않은 까닭 — 오류 코드로만 말한다(주소는 싣지 않는다) */
export function failureHint(e: unknown): string {
  if (e instanceof DOMException && e.name === 'TimeoutError') return `${MAIL_TIMEOUT_MS / 1000}초 안에 답이 없다 — 주소·포트가 맞는지, 방화벽이 막는지 본다`;
  const cause = e instanceof Error ? (e.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  // 원인이 없는 TypeError는 요청을 만들지 못한 것이다(헤더 값에 보낼 수 없는 글자 등) — **문장을 싣지 않는다**: 비밀 값의 몇째 글자가 무엇인지가 들어 있다(코드 리뷰 2)
  if (e instanceof TypeError && cause === undefined) return '요청을 만들지 못했다 — WF_MAIL_AUTH_VALUE·WF_MAIL_SENDER_NAME에 보낼 수 없는 글자가 없는지 본다';
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const message = typeof cause?.message === 'string' ? cause.message : '';
  // 코드가 있으면 코드로 먼저 가린다 — 문장에는 호스트 이름이 들어 있어 문장만 보면 오진한다(호스트 이름에 "redirect"가 든 경우 — 자체 점검 5)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `호스트 이름을 찾지 못했다 (${code}) — 주소의 호스트를 본다`;
  if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') return `메일 API의 인증서가 만료됐거나 아직 유효하지 않다 (${code}) — 메일 API 담당에게 알린다`;
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return `인증서의 호스트 이름이 주소와 다르다 (${code}) — 주소의 호스트를 인증서에 적힌 이름으로 적는다`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code))
    return `인증서를 믿지 못했다 (${code}) — 사내 인증 기관이면 compose 옆 ca/ca.pem에 두고 다시 친다(반입 가이드 10절 ②)`;
  if (code) return `메일 API에 닿지 않는다 (${code}) — 주소·포트와 망을 본다`;
  if (/redirect/i.test(message)) return '메일 API가 다른 주소로 넘겼다 — 넘겨주기는 따르지 않는다(인증 값이 다른 곳으로 가지 않게). 넘겨 준 곳의 주소를 WF_MAIL_API_URL에 적는다';
  // fetch는 메일·원격 제어 등에 쓰는 포트(25·465·587·993·995 등)로는 아예 보내지 않는다 — 연결을 시도하지도 않는다(코드 리뷰 5)
  if (/bad port/i.test(message)) return '그 포트로는 보낼 수 없다(fetch가 막는 포트 — 25·465·587 등 메일 서버 자체의 포트) — 메일 API(HTTP)의 포트를 적었는지 본다';
  return '메일 API에 닿지 않는다 — 주소·포트와 망을 본다';
}
