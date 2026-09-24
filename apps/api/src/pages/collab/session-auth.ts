import { unsign } from 'cookie-signature';

/**
 * WebSocket **연결 시점**에 세션을 읽는다 (P6_설계서_Collab FR-703).
 *
 * **왜 express-session 미들웨어를 다시 쓰지 않는가.** 그 미들웨어는 `res`를 요구하는데
 * 업그레이드 요청에는 진짜 응답 객체가 없다. 가짜를 만들어 끼우면 동작은 하지만,
 * **인증이 남의 코드 안에서 일어나 보이지 않게 된다.** 이 경로는 권한의 입구라
 * 눈에 보이는 편이 낫다 (1.3절과 같은 판단).
 *
 * 하는 일은 셋뿐이다: 쿠키에서 이름을 찾고, 서명을 벗기고, 저장소에서 찾는다.
 *
 * **쿠키 파싱에 라이브러리를 쓰지 않는다.** `cookie` 패키지를 넣어 봤더니 ESM 전용이라
 * CommonJS인 api에서 쓸 수 없었다. 우회하는 설정을 더하는 것보다 **여섯 줄을 우리가
 * 쓰는 편**이 낫다 — 반입 묶음에 들어갈 의존성도 하나 줄어든다 (8.3절).
 * 서명 확인은 직접 쓰지 않는다. 그쪽은 타이밍 안전 비교가 필요해 라이브러리를 쓴다.
 */

/** `a=1; b=2` → `{a:'1', b:'2'}`. 값의 퍼센트 인코딩을 푼다 */
function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key || key in out) continue; // 먼저 나온 것을 쓴다
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[key] = part.slice(i + 1).trim(); // 인코딩이 깨져 있어도 터지지 않는다
    }
  }
  return out;
}

/** `main.ts`의 `session({ name })`과 같아야 한다 */
export const SESSION_COOKIE = 'wf.sid';

export type SessionRow = { sess: { userId?: string } };

/**
 * 서명된 쿠키에서 세션 id를 꺼낸다.
 *
 * express-session은 `s:<sid>.<서명>` 모양으로 쓴다. **서명을 확인하지 않고 sid만
 * 떼어 쓰면 아무 sid나 넣어 볼 수 있다** — 세션 id는 추측하기 어렵지만 "어렵다"는
 * 방어가 아니다.
 */
export function readSessionId(cookieHeader: string | undefined, secret: string): string | null {
  if (!cookieHeader) return null;
  const raw = parseCookieHeader(cookieHeader)[SESSION_COOKIE];
  if (!raw) return null;
  if (!raw.startsWith('s:')) return null;
  const value = unsign(raw.slice(2), secret);
  return value === false ? null : value;
}

/** 경로에서 페이지 id를 꺼낸다. uuid가 아니면 `null` — 그 값이 질의에 들어가기 때문이다 */
const WS_PATH = /^\/api\/ws\/pages\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function readPageId(url: string | undefined): string | null {
  if (!url) return null;
  // 쿼리와 해시를 떼고 본다. `?x=1`이 붙었다고 거부할 이유는 없다
  const path = url.split(/[?#]/)[0];
  return WS_PATH.exec(path)?.[1] ?? null;
}

/**
 * 연결한 사람의 주소 — 감사로그의 `ip` (P9_설계서_Gate D.6).
 *
 * **HTTP 쪽 `req.ip`와 같은 규칙이다.** `WF_TRUST_PROXY`면 Express는 한 단계(nginx)를 믿으므로(`trust proxy = 1`),
 * 그 nginx가 덧붙인 `X-Forwarded-For`의 **마지막** 항목이 연결한 사람이다. 앞쪽 항목은 클라이언트가 적어 보낼 수 있다.
 * 업그레이드 요청은 Express를 거치지 않아 `req.ip`가 없다 — 그래서 같은 규칙을 여기서 쓴다.
 */
export function readClientIp(forwardedFor: string | string[] | undefined, remoteAddress: string | undefined, trustProxy: boolean): string | null {
  if (trustProxy && forwardedFor) {
    const joined = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const last = joined.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return remoteAddress ?? null;
}
