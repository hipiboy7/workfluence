import { HttpException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import { API_RATE_LIMITS } from '@workfluence/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitStore } from '../common/rate-limit.guard';
import { ChatApiRateGuard } from './chat-api-rate.guard';
import { ChatEnabledGuard } from './chat.enabled.guard';

/** P21 쟁점 2 — 채팅 쓰기는 공개 API의 쓰기 한도(분당 30)가 아니라 채팅 전용 한도(`WF_CHAT_SEND_PER_MIN`)를 쓴다. 읽기는 공개 API의 읽기 한도다 */

function ctx(method: string, tokenId?: string) {
  const headers: Record<string, string> = {};
  const req = { method, ip: '10.0.0.1', apiToken: tokenId ? { id: tokenId, scopes: ['write'] } : undefined };
  const res = { setHeader: (k: string, v: string) => void (headers[k] = v) };
  return { exec: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext, headers };
}
const burst = (g: ChatApiRateGuard, method: string, n: number, tokenId = 't1'): (HttpException | null)[] =>
  Array.from({ length: n }, () => {
    try {
      g.canActivate(ctx(method, tokenId).exec);
      return null;
    } catch (e) {
      return e as HttpException;
    }
  });

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-12T00:00:00Z') }));
afterEach(() => vi.useRealTimers());

describe('ChatApiRateGuard', () => {
  it('읽기는 공개 API의 읽기 한도(120)까지 받고 넘으면 429와 Retry-After', () => {
    const g = new ChatApiRateGuard(new RateLimitStore());
    expect(burst(g, 'GET', API_RATE_LIMITS.read.max).every((e) => e === null)).toBe(true);
    const c = ctx('GET', 't1');
    let over: HttpException | null = null;
    try {
      g.canActivate(c.exec);
    } catch (e) {
      over = e as HttpException;
    }
    expect(over?.getStatus()).toBe(429);
    expect(over?.getResponse()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(c.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
  });

  it('쓰기는 여기서 세지 않는다 — 공개 API의 쓰기 한도(30)를 채팅에 적용하지 않는다(채팅 쓰기 한도는 사용자마다 서비스가 센다)', () => {
    const g = new ChatApiRateGuard(new RateLimitStore());
    expect(API_RATE_LIMITS.write.max).toBe(30);
    expect(burst(g, 'POST', 200).every((e) => e === null)).toBe(true);
  });

  it('읽기는 토큰마다 따로 센다', () => {
    const g = new ChatApiRateGuard(new RateLimitStore());
    burst(g, 'GET', API_RATE_LIMITS.read.max);
    expect(burst(g, 'GET', 1)[0]).not.toBeNull();
    expect(burst(g, 'GET', 1, 't2')[0]).toBeNull();
  });

  it('1분이 지나면 다시 받는다', () => {
    const g = new ChatApiRateGuard(new RateLimitStore());
    burst(g, 'GET', API_RATE_LIMITS.read.max);
    vi.advanceTimersByTime(61_000);
    expect(burst(g, 'GET', 1)[0]).toBeNull();
  });

  it('토큰 가드를 거치지 않은 요청은 세지 않는다', () => {
    const g = new ChatApiRateGuard(new RateLimitStore());
    for (let i = 0; i < 300; i++) expect(g.canActivate(ctx('GET').exec)).toBe(true);
  });
});

describe('ChatEnabledGuard (FR-2420)', () => {
  it('꺼져 있으면 없는 경로와 같은 404 — 까닭 코드를 싣는다', () => {
    try {
      new ChatEnabledGuard({ WF_CHAT_ENABLED: false }).canActivate();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundException);
      expect((e as NotFoundException).getResponse()).toMatchObject({ code: 'CHAT_DISABLED' });
    }
  });
  it('켜져 있으면 지나간다', () => {
    expect(new ChatEnabledGuard({ WF_CHAT_ENABLED: true }).canActivate()).toBe(true);
  });
});
