import { LOG_LIMITS, type LogEvent } from '@workfluence/shared';

/** 요청 하나가 끝났을 때 아는 것 */
export type AccessLogInput = {
  method: string;
  /** 받은 주소 — 질의 문자열이 들어 있을 수 있다. 여기서 버린다 */
  url: string;
  /** 라우터가 맞춘 경로 틀(`/api/pages/:id`). 맞춘 것이 없으면 `null` */
  route: string | null;
  status: number;
  durationMs: number;
  /** 로그인한 사용자(불투명 id). 없으면 `null` */
  userId: string | null;
  /** 끝(`finish`) 전에 받는 쪽이 끊었다 */
  aborted: boolean;
};

export type AccessLogEntry = {
  level: 'info' | 'warn';
  msg: string;
  fields: { event: LogEvent } & Record<string, unknown>;
};

const HEALTH_PATH = '/api/health';

/**
 * 앱 접근 로그 한 줄 (P11_설계서_Ops D.3, FR-1213). 남기지 않을 요청이면 `null`.
 *
 * - **질의 문자열은 어디에도 싣지 않는다** — 검색어가 들어 있다. 경로 틀을 싣고, 맞춘 라우트가 없을 때만 경로를 줄여 싣는다
 * - 헬스체크(20초마다 온다)와 `/api` 밖(SPA 정적 자산 — nginx 로그에 있다)은 남기지 않는다 (A.1-7)
 * - 5xx만 `warn` — 401·403·404·409는 정상 흐름이다. 처리되지 않은 예외는 `http.unhandled` 줄이 따로 있다 (A.1-8)
 */
export function accessLogEntry(x: AccessLogInput): AccessLogEntry | null {
  const path = x.url.split('?', 1)[0];
  // **대소문자를 가리지 않고 본다** — 라우터가 `/API/…`도 같은 처리기·가드로 보낸다. 가리면 대문자로 부른 요청이 접근 로그에서만 빠진다
  // (P11 보안 검토 2). 싣는 경로는 받은 그대로다
  const lower = path.toLowerCase();
  if (lower !== '/api' && !lower.startsWith('/api/')) return null;
  if (lower === HEALTH_PATH) return null;

  // **전체 잡기 라우트는 맞춘 라우트가 아니다** — SPA 정적 자산의 틀(`{*any}`)이 맞춘 것이 없는 API 요청에도 씌워진다(Nest 12·Express 5).
  // 그 틀을 적으면 404가 전부 `GET {*any} 404`로 보여 무엇을 불렀는지 모른다 (P11 자체 점검 2)
  const route = x.route !== null && !x.route.includes('*') ? x.route : null;
  const fields: AccessLogEntry['fields'] = {
    event: 'http.request',
    method: x.method,
    route,
    status: x.status,
    durationMs: Math.round(x.durationMs),
  };
  const shown = route ?? path.slice(0, LOG_LIMITS.accessLogPathMaxChars);
  if (route === null) fields.path = shown;
  if (x.userId) fields.userId = x.userId;
  if (x.aborted) fields.aborted = true;
  return { level: x.status >= 500 ? 'warn' : 'info', msg: `${x.method} ${shown} ${x.status}`, fields };
}
