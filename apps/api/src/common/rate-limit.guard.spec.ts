import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitGuard, type RateLimitSpec } from './rate-limit.guard';

/** 가드는 Reflector로 핸들러 메타데이터를 읽고 요청에서 IP를 본다. 그 둘만 흉내 낸다. */
function makeContext(ip: string, handlerName = 'h', className = 'C'): ExecutionContext {
  const handler = { name: handlerName };
  return {
    switchToHttp: () => ({ getRequest: () => ({ ip }) }),
    getHandler: () => handler,
    getClass: () => ({ name: className }),
  } as unknown as ExecutionContext;
}

function makeReflector(spec: RateLimitSpec | undefined): Reflector {
  return { get: vi.fn().mockReturnValue(spec) } as unknown as Reflector;
}

describe('RateLimitGuard (FR-061)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('제한이 선언되지 않은 핸들러는 통과시킨다', () => {
    const guard = new RateLimitGuard(makeReflector(undefined));
    for (let i = 0; i < 50; i++) expect(guard.canActivate(makeContext('1.1.1.1'))).toBe(true);
  });

  it('창 안에서 상한을 넘으면 429를 던진다', () => {
    const guard = new RateLimitGuard(makeReflector({ max: 3, windowSec: 60 }));
    const ctx = makeContext('1.1.1.1');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    try {
      guard.canActivate(ctx);
      expect.unreachable('4번째는 막혀야 한다');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(429);
    }
  });

  it('IP가 다르면 서로의 한도를 쓰지 않는다', () => {
    const guard = new RateLimitGuard(makeReflector({ max: 1, windowSec: 60 }));
    expect(guard.canActivate(makeContext('1.1.1.1'))).toBe(true);
    expect(guard.canActivate(makeContext('2.2.2.2'))).toBe(true);
    expect(() => guard.canActivate(makeContext('1.1.1.1'))).toThrow(HttpException);
  });

  it('핸들러가 다르면 서로의 한도를 쓰지 않는다', () => {
    const guard = new RateLimitGuard(makeReflector({ max: 1, windowSec: 60 }));
    expect(guard.canActivate(makeContext('1.1.1.1', 'login'))).toBe(true);
    expect(guard.canActivate(makeContext('1.1.1.1', 'signup'))).toBe(true);
  });

  it('창이 지나면 다시 허용한다', () => {
    vi.useFakeTimers();
    const guard = new RateLimitGuard(makeReflector({ max: 1, windowSec: 60 }));
    const ctx = makeContext('1.1.1.1');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    vi.advanceTimersByTime(61_000);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('IP를 모르면 unknown 키로 묶는다', () => {
    const guard = new RateLimitGuard(makeReflector({ max: 1, windowSec: 60 }));
    const ctx = { switchToHttp: () => ({ getRequest: () => ({}) }), getHandler: () => ({ name: 'h' }), getClass: () => ({ name: 'C' }) } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
  });
});
