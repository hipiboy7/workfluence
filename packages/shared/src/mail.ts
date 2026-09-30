/**
 * 사내 메일 API 설정의 판정 (A등급, P18_설계서_Mail FR-1902·1904). 설정은 폐쇄망 현장에서 사람이 `deploy/.env`에 적는다 — 틀린 값은 기동에서
 * 막는다(`env.ts`의 `parseEnv`). **비밀은 인증 헤더로만 받는다** — 주소에 섞이면 시험 명령의 창과 로그로 나간다
 */

/** 본문 형식 — 사내 API의 `/send`(평문)와 `/send_markdown` (쟁점 3) */
export const MAIL_FORMATS = ['text', 'markdown'] as const;
export type MailFormat = (typeof MAIL_FORMATS)[number];

export const MAIL_LIMITS = {
  /** 보내는 주소의 길이 상한 */
  apiUrlMaxChars: 2000,
  /** 보내는 이름(`sender_name`)의 길이 상한 */
  senderNameMaxChars: 100,
} as const;

/**
 * 보내는 주소가 틀렸으면 까닭, 맞으면 `null` (빈 값은 부르는 쪽이 본다 — 꺼진 설정이다).
 * `http(s)`만, 사용자 정보·질의·조각 없이 — 사내 LLM 주소(`normalizeLlmBaseUrl`)와 같은 판단이다. 주소는 끝의 `/`까지 적힌 그대로 쓴다(보내는 주소 전체다)
 */
export function mailApiUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (value.length > MAIL_LIMITS.apiUrlMaxChars) return `주소가 너무 길다 (${MAIL_LIMITS.apiUrlMaxChars}자까지)`;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return '주소 형식이 아니다 — https://호스트/api/v1/email/send 모양으로 적는다';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '주소는 http 또는 https여야 한다';
  if (!u.hostname) return '주소 형식이 아니다 — 호스트가 없다';
  if (u.username || u.password) return '주소에 사용자 정보(아이디·비밀번호)를 넣지 않는다 — 인증은 WF_MAIL_AUTH_HEADER·WF_MAIL_AUTH_VALUE로 적는다';
  if (u.search) return '주소에 질의(?…)를 넣지 않는다 — 키는 WF_MAIL_AUTH_HEADER·WF_MAIL_AUTH_VALUE로 적는다';
  if (u.hash) return '주소에 조각(#…)을 넣지 않는다';
  return null;
}

/**
 * **메일 속 링크의 주소**(`WF_PUBLIC_URL`)가 틀렸으면 까닭, 맞으면 `null` (빈 값은 부르는 쪽이 본다 — 링크 없는 메일이다, P19 병합 전 자체 점검 5).
 * `http(s)`만, 사용자 정보·질의·조각 없이 — 뒤에 경로와 조각(`/reset-password#t=…`)을 붙인다. 스킴이 없는 값은 메일에서 열리지 않는 링크가 된다
 */
export function publicUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return '주소 형식이 아니다 — https://호스트:포트 모양으로 적는다(사람들이 브라우저에 치는 주소)';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '주소는 http 또는 https여야 한다';
  if (!u.hostname) return '주소 형식이 아니다 — 호스트가 없다';
  if (u.username || u.password) return '주소에 사용자 정보(아이디·비밀번호)를 넣지 않는다';
  if (u.search) return '주소에 질의(?…)를 넣지 않는다';
  if (u.hash) return '주소에 조각(#…)을 넣지 않는다';
  return null;
}

/** HTTP 헤더 이름(토큰 글자 — RFC 9110 5.6.2)인가 */
export function isHttpHeaderName(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

/** 인증 헤더로 쓸 수 없는 이름 — 요청의 모양·연결을 바꾸는 머리말이다(소문자로 견준다, P18 코드 리뷰 12) */
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'transfer-encoding', 'connection', 'expect', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization', 'proxy-connection']);

/** 인증 헤더 이름이 틀렸으면 까닭 — HTTP 토큰 글자여야 하고, 요청의 모양을 바꾸는 머리말은 쓸 수 없다 */
export function mailAuthHeaderProblem(name: string): string | null {
  if (!isHttpHeaderName(name)) return 'HTTP 헤더 이름(영문·숫자·-_. 등, 빈칸·콜론 없이)이어야 한다';
  if (RESERVED_HEADERS.has(name.toLowerCase())) return `${name}는 인증 헤더로 쓸 수 없다 — 요청의 모양을 바꾸는 머리말이다. 메일 API 담당에게 받은 인증 헤더 이름을 적는다`;
  return null;
}

/**
 * 헤더 값이 틀렸으면 까닭 — **줄바꿈은 다른 헤더를 끼워 넣는 길이다**. 비어 있으면 안 된다. **보이는 ASCII(와 빈칸·탭)만** — 다른 글자(한글 등)면 보낼 때마다
 * 실패하고, 그 오류 문장이 비밀 값의 몇째 글자가 무엇인지를 로그에 남긴다(P18 병합 전 보안 검토 5)
 */
export function mailHeaderValueProblem(value: string): string | null {
  if (/[\r\n]/.test(value)) return '헤더 값에 줄바꿈을 넣지 않는다';
  // eslint-disable-next-line no-control-regex -- 제어 글자를 찾는 것이 이 판정이다
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return '헤더 값에 제어 글자를 넣지 않는다';
  if (!/^[\t\u0020-\u007E]*$/.test(value)) return '헤더 값은 영문·숫자·기호(보이는 ASCII)만 쓴다 — 메일 API 담당에게 받은 값을 그대로 적는다';
  if (!value.trim()) return '헤더 값이 비었다';
  return null;
}

/** 받는 주소의 길이 상한 — SMTP의 주소 상한(RFC 5321) */
const MAIL_ADDRESS_MAX = 254;

/**
 * 받는 사람이 **주소 하나**인가 (P18 A.1-11) — 사내 메일 API의 `receivers`는 쉼표로 이은 여럿을 받는다. 여기서는 **여럿이 되거나 머리말을 만드는 글자**만
 * 막는다: 쉼표·세미콜론·빈칸·꺾쇠·따옴표·괄호·제어 글자, `@`가 하나가 아닌 것. **모양은 까다롭게 보지 않는다** — 사내 IdP가 주는 주소(한 단어 도메인
 * `user@corp` 등)는 가입 검사(`emailSchema`)보다 느슨할 수 있고, 막으면 그 조직의 부르기 메일이 신호 없이 멈춘다(좁은 재점검 보통 1)
 */
export function isSingleMailAddress(value: string): boolean {
  if (value.length === 0 || value.length > MAIL_ADDRESS_MAX) return false;
  // eslint-disable-next-line no-control-regex -- 제어 글자를 막는 것이 이 판정이다
  return /^[^\s,;<>"()\\@\u0000-\u001F\u007F-\u009F]+@[^\s,;<>"()\\@\u0000-\u001F\u007F-\u009F]+$/.test(value);
}

