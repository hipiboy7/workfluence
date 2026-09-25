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

/**
 * 같은 출처 세션 쿠키 + CSRF 헤더로 API를 호출한다 (CLAUDE.md 7절).
 * 헤더를 여기 한 곳에서 붙인다 — 화면마다 붙이면 새 화면에서 빠뜨리고 403만 본다.
 */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
      ...(headers as Record<string, string> | undefined),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
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
