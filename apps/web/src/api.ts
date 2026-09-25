import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@workfluence/shared';

/** 서버가 준 오류를 화면이 쓸 수 있는 모양으로 옮긴다 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(extractMessage(body) ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

/** zod 파이프는 issues 배열을, Nest는 message를 준다. 둘 다 사람이 읽을 한 줄로 만든다 */
function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; issues?: { path: string; message: string }[] };
    if (Array.isArray(b.issues) && b.issues.length) return b.issues.map((i) => `${i.path}: ${i.message}`).join(', ');
    if (typeof b.message === 'string') return b.message;
    if (b.message && typeof b.message === 'object') return extractMessage(b.message);
  }
  return undefined;
}

export type ApiInit = RequestInit & { json?: unknown };

/**
 * 같은 출처 세션 쿠키 + CSRF 헤더를 붙인 요청 모양 (CLAUDE.md 7절).
 * 헤더를 여기 한 곳에서 붙인다 — 화면마다 붙이면 새 화면에서 빠뜨리고 403만 본다. 흘려받는 요청(`askLlm`)도 이것을 쓴다.
 */
export function requestInit(init: ApiInit = {}): RequestInit {
  const { json, headers, ...rest } = init;
  return {
    credentials: 'same-origin',
    ...rest,
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
      ...(headers as Record<string, string> | undefined),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  };
}

/**
 * 경로에 `.`·`..` 조각이 있는가 (P10 보안 검토 — client-side path traversal).
 *
 * 화면은 주소의 id를 API 경로에 넣는다(`/api/pages/${id}`). 라우터는 주소의 `%2F`를 풀어 넘기므로, 누군가 페이지에 심은
 * `/pages/..%2F..%2Fapi%2F…` 링크를 열면 **연 사람의 세션과 CSRF 머리말로** 다른 API를 부른다 — CSRF 방어(7절)를 옆으로
 * 돌아간다. URL 해석은 `%2e`도 점으로, `\`도 `/`로 읽고 탭·줄바꿈은 지운다 — 그 모두를 본다. 정상 경로에는 그런 조각이 없다
 */
export function hasDotSegment(path: string): boolean {
  const p = path.replace(/[\t\n\r]/g, '').split(/[?#]/, 1)[0];
  return p.split(/[/\\]/).some((s) => /^(?:\.|%2e){1,2}$/i.test(s));
}

/** API를 부른다. **`.`·`..` 조각이 든 경로는 보내지 않는다** (`hasDotSegment`) */
export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  if (hasDotSegment(path)) throw new ApiError(400, { message: '주소에 "."이나 ".." 조각이 있어 요청을 보내지 않았다' });
  const res = await fetch(path, requestInit(init));
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

/**
 * 흐름을 열지 못한 응답을 `ApiError`로 (P10 LLM 질문). 흘려받는 요청은 `api()`를 쓰지 않으므로 오류 읽기만 여기서 같이 쓴다 —
 * 화면이 같은 모양의 오류 문장을 보이게
 */
export async function readApiError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  return new ApiError(res.status, text ? safeJson(text) : undefined);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
