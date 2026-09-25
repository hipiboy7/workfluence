import { describe, expect, it } from 'vitest';
import { accessLogEntry, type AccessLogInput } from './access-log';

/**
 * A등급 — 앱 접근 로그 한 줄을 남기나·어느 수준인가·무엇을 싣나 (P11 D.3, FR-1213). **질의 문자열은 어디에도 싣지 않는다**(검색어)
 */
const base: AccessLogInput = { method: 'GET', url: '/api/pages/p1', route: '/api/pages/:id', status: 200, durationMs: 12.4, userId: 'u1', aborted: false };

describe('accessLogEntry', () => {
  it('**경로 틀·상태·걸린 시간·사용자** — event는 `http.request`, 수준은 info', () => {
    expect(accessLogEntry(base)).toEqual({
      level: 'info',
      msg: 'GET /api/pages/:id 200',
      fields: { event: 'http.request', method: 'GET', route: '/api/pages/:id', status: 200, durationMs: 12, userId: 'u1' },
    });
  });

  it('**질의 문자열을 싣지 않는다** — 맞춘 라우트가 없어 경로를 실을 때도', () => {
    const e = accessLogEntry({ ...base, url: '/api/search?q=비밀 검색어', route: '/api/search' });
    expect(JSON.stringify(e)).not.toContain('비밀');
    const miss = accessLogEntry({ ...base, url: '/api/nope/x?q=비밀', route: null, status: 404 });
    expect(miss?.fields).toMatchObject({ route: null, path: '/api/nope/x', status: 404 });
    expect(JSON.stringify(miss)).not.toContain('비밀');
  });

  it('**전체 잡기 라우트(`{*any}`·`*`)는 맞춘 라우트가 아니다** — SPA 정적 자산의 틀이 API 404에 씌워진다(Nest 12·Express 5). 경로를 싣는다 (P11 자체 점검 2)', () => {
    for (const route of ['{*any}', '*', '/*splat']) {
      const e = accessLogEntry({ ...base, url: '/api/definitely-not-a-route/x?q=비밀', route, status: 404 });
      expect(e?.fields, route).toMatchObject({ route: null, path: '/api/definitely-not-a-route/x', status: 404 });
      expect(e?.msg, route).toBe('GET /api/definitely-not-a-route/x 404');
      expect(JSON.stringify(e), route).not.toContain('비밀');
    }
  });

  it('**대소문자를 가리지 않는다** — 라우터가 `/API/…`도 같은 처리기·가드로 보내므로 접근 로그도 같게 본다 (P11 보안 검토 2)', () => {
    expect(accessLogEntry({ ...base, url: '/API/pages/p1', route: '/api/pages/:id' })?.fields.route).toBe('/api/pages/:id');
    expect(accessLogEntry({ ...base, url: '/Api/nope?q=비밀', route: null, status: 404 })?.fields).toMatchObject({ route: null, path: '/Api/nope' });
    expect(accessLogEntry({ ...base, url: '/API', route: null, status: 404 })).not.toBeNull();
    // 헬스체크도 같다 — 대문자로 불러도 헬스체크다
    expect(accessLogEntry({ ...base, url: '/API/Health', route: '/api/health' })).toBeNull();
  });

  it('맞춘 라우트가 없으면 경로를 200자까지', () => {
    const long = `/api/${'x'.repeat(300)}`;
    expect((accessLogEntry({ ...base, url: long, route: null, status: 404 })?.fields.path as string).length).toBe(200);
  });

  it('**5xx는 warn**, 4xx는 정상 흐름이라 info (A.1-8)', () => {
    expect(accessLogEntry({ ...base, status: 503 })?.level).toBe('warn');
    expect(accessLogEntry({ ...base, status: 500 })?.level).toBe('warn');
    for (const s of [401, 403, 404, 409]) expect(accessLogEntry({ ...base, status: s })?.level).toBe('info');
  });

  it('**받는 쪽이 먼저 끊으면** 그렇다고 적는다 — LLM 답을 받다 떠난 것', () => {
    expect(accessLogEntry({ ...base, aborted: true })?.fields).toMatchObject({ aborted: true });
    expect(accessLogEntry(base)?.fields).not.toHaveProperty('aborted');
  });

  it('로그인하지 않은 요청에는 사용자가 없다', () => {
    expect(accessLogEntry({ ...base, userId: null })?.fields).not.toHaveProperty('userId');
  });

  it('**헬스체크와 정적 자산은 남기지 않는다** (A.1-7)', () => {
    expect(accessLogEntry({ ...base, url: '/api/health', route: '/api/health' })).toBeNull();
    expect(accessLogEntry({ ...base, url: '/api/health?x=1', route: '/api/health' })).toBeNull();
    for (const url of ['/', '/assets/index-abc.js', '/pages/p1', '/apiary']) expect(accessLogEntry({ ...base, url, route: null }), url).toBeNull();
  });
});
