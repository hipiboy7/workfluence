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
  it('쓰기는 공개 API의 쓰기 한도(30)를 넘어 채팅 한도까지 받는다', () => {
    const g = new ChatApiRateGuard(new RateLimitStore(), { WF_CHAT_SEND_PER_MIN: 40 });
    expect(API_RATE_LIMITS.write.max).toBe(30);
    expect(burst(g, 'POST', 40).every((e) => e === null)).toBe(true);
    const over = burst(g, 'POST', 1)[0]!;
    expect(over.getStatus()).toBe(429);
    expect(over.getResponse()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('넘으면 Retry-After(초)를 싣는다', () => {
    const g = new ChatApiRateGuard(new RateLimitStore(), { WF_CHAT_SEND_PER_MIN: 1 });
    burst(g, 'POST', 1);
    const c = ctx('POST', 't1');
    expect(() => g.canActivate(c.exec)).toThrow(HttpException);
    expect(Number(c.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
  });

  it('읽기는 공개 API의 읽기 한도(120)이고 쓰기와 따로 센다 — 토큰마다도 따로', () => {
    const g = new ChatApiRateGuard(new RateLimitStore(), { WF_CHAT_SEND_PER_MIN: 2 });
    expect(burst(g, 'GET', API_RATE_LIMITS.read.max).every((e) => e === null)).toBe(true);
    expect(burst(g, 'GET', 1)[0]?.getStatus()).toBe(429);
    expect(burst(g, 'POST', 2).every((e) => e === null)).toBe(true); // 쓰기 예산은 따로
    expect(burst(g, 'POST', 2, 't2').every((e) => e === null)).toBe(true); // 다른 토큰은 따로
  });

  it('1분이 지나면 다시 받는다', () => {
    const g = new ChatApiRateGuard(new RateLimitStore(), { WF_CHAT_SEND_PER_MIN: 1 });
    burst(g, 'POST', 1);
    expect(burst(g, 'POST', 1)[0]).not.toBeNull();
    vi.advanceTimersByTime(61_000);
    expect(burst(g, 'POST', 1)[0]).toBeNull();
  });

  it('토큰 가드를 거치지 않은 요청은 세지 않는다', () => {
    const g = new ChatApiRateGuard(new RateLimitStore(), { WF_CHAT_SEND_PER_MIN: 1 });
    for (let i = 0; i < 5; i++) expect(g.canActivate(ctx('POST').exec)).toBe(true);
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
