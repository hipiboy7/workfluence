import { HttpException, type ExecutionContext } from '@nestjs/common';
import { API_RATE_LIMITS } from '@workfluence/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitStore } from '../common/rate-limit.guard';
import { ApiRateLimitGuard } from './api-rate-limit.guard';

/**
 * 토큰별 빈도 제한 (docs/spinoff/public-api 설계서 FR-2213). 에이전트는 사람보다 훨씬 자주 부른다 — 한 토큰이 서버를 독차지하지 못하게 **토큰마다**
 * 읽기와 쓰기를 따로 센다. 세는 것은 토큰 가드를 **통과한** 요청뿐이다(가드 순서: 토큰 → 빈도 제한)
 */

function ctx(opts: { method?: string; tokenId?: string }) {
  const headers: Record<string, string> = {};
  const req = { method: opts.method ?? 'GET', ip: '10.0.0.1', apiToken: opts.tokenId ? { id: opts.tokenId, scopes: ['write'] } : undefined };
  const res = {
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
  };
  const exec = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
  return { exec, headers };
}

const guard = () => new ApiRateLimitGuard(new RateLimitStore());

function limited(g: ApiRateLimitGuard, c: ReturnType<typeof ctx>): HttpException | null {
  try {
    g.canActivate(c.exec);
    return null;
  } catch (e) {
    return e as HttpException;
  }
}

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-07T00:00:00Z') }));
afterEach(() => vi.useRealTimers());

describe('ApiRateLimitGuard', () => {
  it('토큰 가드를 거치지 않은 요청(상태 확인·명세)은 세지 않는다', () => {
    const g = guard();
    for (let i = 0; i < API_RATE_LIMITS.read.max + 10; i++) expect(g.canActivate(ctx({}).exec)).toBe(true);
  });

  it('읽기는 상한까지 통과하고 그다음은 429 RATE_LIMITED — Retry-After와 기다릴 초를 말한다', () => {
    const g = guard();
    for (let i = 0; i < API_RATE_LIMITS.read.max; i++) expect(g.canActivate(ctx({ tokenId: 't1' }).exec)).toBe(true);
    const c = ctx({ tokenId: 't1' });
    const e = limited(g, c);
    expect(e?.getStatus()).toBe(429);
    const body = e?.getResponse() as { code: string; message: string; details: { retryAfterSec: number } };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.retryAfterSec).toBeGreaterThan(0);
    expect(body.details.retryAfterSec).toBeLessThanOrEqual(API_RATE_LIMITS.read.windowSec);
    expect(c.headers['Retry-After']).toBe(String(body.details.retryAfterSec));
  });

  it('**읽기와 쓰기는 따로 센다** — 읽기가 가득 차도 쓰기는 된다', () => {
    const g = guard();
    for (let i = 0; i < API_RATE_LIMITS.read.max; i++) g.canActivate(ctx({ tokenId: 't1' }).exec);
    expect(limited(g, ctx({ tokenId: 't1' }))?.getStatus()).toBe(429);
    expect(g.canActivate(ctx({ tokenId: 't1', method: 'POST' }).exec)).toBe(true);
  });

  it('쓰기 상한은 읽기보다 작다 — PATCH·DELETE도 쓰기다', () => {
    expect(API_RATE_LIMITS.write.max).toBeLessThan(API_RATE_LIMITS.read.max);
    const g = guard();
    const methods = ['POST', 'PATCH', 'DELETE'];
    for (let i = 0; i < API_RATE_LIMITS.write.max; i++) g.canActivate(ctx({ tokenId: 't1', method: methods[i % 3] }).exec);
    expect(limited(g, ctx({ tokenId: 't1', method: 'PATCH' }))?.getStatus()).toBe(429);
  });

  it('**토큰마다 따로다** — 한 토큰이 가득 차도 다른 토큰은 된다', () => {
    const g = guard();
    for (let i = 0; i < API_RATE_LIMITS.read.max; i++) g.canActivate(ctx({ tokenId: 't1' }).exec);
    expect(limited(g, ctx({ tokenId: 't1' }))?.getStatus()).toBe(429);
    expect(g.canActivate(ctx({ tokenId: 't2' }).exec)).toBe(true);
  });

  it('창이 지나면 다시 통과한다', () => {
    const g = guard();
    for (let i = 0; i < API_RATE_LIMITS.read.max; i++) g.canActivate(ctx({ tokenId: 't1' }).exec);
    expect(limited(g, ctx({ tokenId: 't1' }))?.getStatus()).toBe(429);
    vi.advanceTimersByTime(API_RATE_LIMITS.read.windowSec * 1000 + 1);
    expect(g.canActivate(ctx({ tokenId: 't1' }).exec)).toBe(true);
  });
});
