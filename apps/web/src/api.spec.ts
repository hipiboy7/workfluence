import { CSRF_HEADER } from '@workfluence/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, hasDotSegment, requestInit } from './api';

/** 모든 API 호출이 지나는 한 곳 (CLAUDE.md 7절). `.`·`..` 조각 막기는 P10 보안 검토 반영이다 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hasDotSegment — URL 해석이 앞 조각을 지우게 하는 조각', () => {
  it('**점 조각을 어떤 모양으로 써도 본다** — `%2e`·`\\`·탭·줄바꿈', () => {
    for (const p of [
      '/api/pages/../../api/admin',
      '/api/pages/./x',
      '/api/pages/%2e%2e/x',
      '/api/pages/.%2E/x',
      '/api/pages/%2E./x',
      '/api/pages/..\\..\\api\\admin',
      '/api/pages/.\t./x',
      '/api/pages/..',
    ]) {
      expect(hasDotSegment(p), p).toBe(true);
    }
  });

  it('정상 경로는 지난다 — 점이 든 이름, 질의·조각의 `..`', () => {
    for (const p of ['/api/pages/3f2a/versions/2', '/api/files/a.b.c', '/api/pages/...', '/api/search?q=../x', '/api/x#../y', '/api/llm/conversations/%2e%2e%2fx']) {
      expect(hasDotSegment(p), p).toBe(false);
    }
  });
});

describe('api()', () => {
  it('**점 조각이 든 경로는 보내지 않는다** — 주소의 id로 다른 API를 부르지 못한다 (P10 보안 검토)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const e = await api('/api/pages/../../api/users/u1/role', { method: 'PATCH', json: { role: 'root' } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).toMatch(/조각이 있어/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('같은 출처 쿠키와 CSRF 머리말을 붙이고, JSON이면 몸통과 형식을 붙인다', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true}') } as unknown as Response));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await api('/api/x', { method: 'POST', json: { a: 1 } })).toEqual({ ok: true });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toEqual(requestInit({ method: 'POST', json: { a: 1 } }));
    expect(init).toMatchObject({ credentials: 'same-origin', body: '{"a":1}', headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' } });
  });
});
