import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitGuard, RateLimitStore, type RateLimitSpec } from './rate-limit.guard';

/** 가드는 Reflector로 핸들러 메타데이터를 읽고 요청에서 IP를 본다. 그 둘만 흉내 낸다. */
function makeContext(ip: string, handlerName = 'h', className = 'C', req: Record<string, unknown> = {}): ExecutionContext {
  const handler = { name: handlerName };
  Object.assign(req, { ip });
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => ({ name: className }),
  } as unknown as ExecutionContext;
}

function makeReflector(spec: RateLimitSpec | undefined): Reflector {
  return { get: vi.fn().mockReturnValue(spec) } as unknown as Reflector;
}

/** 저장소를 함께 만들어 돌려준다. 환불을 부르는 쪽은 **저장소**다 (T-027) */
function makeGuard(spec: RateLimitSpec | undefined): { guard: RateLimitGuard; store: RateLimitStore } {
  const store = new RateLimitStore();
  return { guard: new RateLimitGuard(makeReflector(spec), store), store };
}

describe('RateLimitGuard (FR-061)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('제한이 선언되지 않은 핸들러는 통과시킨다', () => {
    const { guard } = makeGuard(undefined);
    for (let i = 0; i < 50; i++) expect(guard.canActivate(makeContext('1.1.1.1'))).toBe(true);
  });

  it('창 안에서 상한을 넘으면 429를 던진다', () => {
    const { guard } = makeGuard({ max: 3, windowSec: 60 });
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
    const { guard } = makeGuard({ max: 1, windowSec: 60 });
    expect(guard.canActivate(makeContext('1.1.1.1'))).toBe(true);
    expect(guard.canActivate(makeContext('2.2.2.2'))).toBe(true);
    expect(() => guard.canActivate(makeContext('1.1.1.1'))).toThrow(HttpException);
  });

  it('핸들러가 다르면 서로의 한도를 쓰지 않는다', () => {
    const { guard } = makeGuard({ max: 1, windowSec: 60 });
    expect(guard.canActivate(makeContext('1.1.1.1', 'login'))).toBe(true);
    expect(guard.canActivate(makeContext('1.1.1.1', 'signup'))).toBe(true);
  });

  it('창이 지나면 다시 허용한다', () => {
    vi.useFakeTimers();
    const { guard } = makeGuard({ max: 1, windowSec: 60 });
    const ctx = makeContext('1.1.1.1');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    vi.advanceTimersByTime(61_000);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('IP를 모르면 unknown 키로 묶는다', () => {
    const { guard } = makeGuard({ max: 1, windowSec: 60 });
    const ctx = { switchToHttp: () => ({ getRequest: () => ({}) }), getHandler: () => ({ name: 'h' }), getClass: () => ({ name: 'C' }) } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
  });
});

describe('성공한 요청은 예산을 돌려준다 (T-023)', () => {
  it('**성공을 세지 않으면 사내 NAT 뒤 정상 사용자가 막히지 않는다**', () => {
    const { guard, store } = makeGuard({ max: 3, windowSec: 60 });
    // 세 번 성공하면 세 번 다 돌려받으므로 계속 통과한다
    for (let i = 0; i < 10; i++) {
      const req: Record<string, unknown> = {};
      expect(guard.canActivate(makeContext('1.1.1.1', 'h', 'C', req))).toBe(true);
      store.refund(req as never);
    }
  });

  it('실패는 그대로 센다 — 무차별 대입은 여전히 막힌다', () => {
    const { guard } = makeGuard({ max: 3, windowSec: 60 });
    for (let i = 0; i < 3; i++) expect(guard.canActivate(makeContext('2.2.2.2'))).toBe(true);
    expect(() => guard.canActivate(makeContext('2.2.2.2'))).toThrow(HttpException);
  });

  it('돌려주기를 두 번 불러도 남의 몫까지 지우지 않는다', () => {
    const { guard, store } = makeGuard({ max: 2, windowSec: 60 });
    const req: Record<string, unknown> = {};
    guard.canActivate(makeContext('3.3.3.3', 'h', 'C', req)); // 성공
    guard.canActivate(makeContext('3.3.3.3')); // 실패로 남는다
    store.refund(req as never);
    store.refund(req as never);
    // 실패 1건만 남아 있어야 한다 — 한 번 더 통과하고 그다음이 막힌다
    expect(guard.canActivate(makeContext('3.3.3.3'))).toBe(true);
    expect(() => guard.canActivate(makeContext('3.3.3.3'))).toThrow(HttpException);
  });

  it('제한이 없는 핸들러에서 돌려주기를 불러도 아무 일도 없다', () => {
    const { store } = makeGuard(undefined);
    expect(() => store.refund({} as never)).not.toThrow();
  });
});

/**
 * **가드가 둘이어도 예산은 하나다** (T-027).
 *
 * Nest는 `@UseGuards(RateLimitGuard)`의 가드를 provider와 별개의 인스턴스로 만든다.
 * 예전에는 센 것을 가드가 들고 있어서, 컨트롤러가 주입받은 가드로 환불을 불러도
 * **다른 Map을 보고 아무 일도 하지 않았다.** 로그인 성공이 계속 예산을 먹었고
 * 스물한 번째 로그인이 429로 막혔다 — 실제 컨테이너에서 그렇게 나왔다.
 *
 * 이 테스트는 그 조립을 흉내 낸다. 가드를 **두 개** 만들고 한쪽으로 세고 다른 쪽으로
 * 환불한다. 예전 코드에서는 실패하고, 상태를 저장소로 뺀 지금은 통과한다.
 */
describe('가드 인스턴스가 달라도 같은 예산을 본다 (T-027)', () => {
  it('한 가드로 세고 다른 가드 쪽에서 환불해도 예산이 돌아온다', () => {
    const store = new RateLimitStore();
    const spec: RateLimitSpec = { max: 3, windowSec: 60 };
    const counting = new RateLimitGuard(makeReflector(spec), store);
    // Nest가 따로 만드는 그 인스턴스에 해당한다. **저장소만 같다**
    const other = new RateLimitGuard(makeReflector(spec), store);

    for (let i = 0; i < 10; i++) {
      const req: Record<string, unknown> = {};
      expect(counting.canActivate(makeContext('9.9.9.9', 'h', 'C', req))).toBe(true);
      store.refund(req as never);
    }
    expect(store.countFor('C.h:9.9.9.9')).toBe(0);
    // 다른 가드로도 같은 예산을 본다
    expect(other.canActivate(makeContext('9.9.9.9'))).toBe(true);
  });
});

/**
 * **긴 창을 쓰는 제한이 짧은 창의 트래픽에 리셋되지 않는다.**
 *
 * 청소가 "지금 들어온 요청의 창"으로 모든 키를 판정하고 있었다. 로그인은 60초 창이고
 * 가입은 600초 창이라, **로그인 한 번이 들어오면** 최근 60초에 히트가 없는 가입 키를
 * 통째로 지웠다 — 무차별 대입을 막으려고 둔 장치가 **평범한 트래픽만 있으면 풀린다.**
 */
describe('창 길이가 다른 제한이 서로를 지우지 않는다', () => {
  it('짧은 창 요청이 긴 창 예산을 리셋하지 않는다', () => {
    vi.useFakeTimers();
    const store = new RateLimitStore();
    const signup = new RateLimitGuard(makeReflector({ max: 2, windowSec: 600 }), store);
    const login = new RateLimitGuard(makeReflector({ max: 20, windowSec: 60 }), store);

    // 가입 예산을 다 쓴다
    expect(signup.canActivate(makeContext('1.1.1.1', 'signup'))).toBe(true);
    expect(signup.canActivate(makeContext('1.1.1.1', 'signup'))).toBe(true);
    expect(() => signup.canActivate(makeContext('1.1.1.1', 'signup'))).toThrow(HttpException);

    // 2분 뒤 — 가입 창(600초)은 아직 살아 있고 로그인 창(60초)은 지났다
    vi.advanceTimersByTime(120_000);
    expect(login.canActivate(makeContext('1.1.1.1', 'login'))).toBe(true);

    // **가입은 여전히 막혀 있어야 한다.** 예전 코드에서는 여기서 통과했다
    expect(store.countFor('C.signup:1.1.1.1')).toBe(2);
    expect(() => signup.canActivate(makeContext('1.1.1.1', 'signup'))).toThrow(HttpException);
    vi.useRealTimers();
  });

  it('자기 창이 지나면 정상적으로 다시 허용한다 — 청소가 아예 안 되는 것은 아니다', () => {
    vi.useFakeTimers();
    const store = new RateLimitStore();
    const signup = new RateLimitGuard(makeReflector({ max: 1, windowSec: 600 }), store);
    expect(signup.canActivate(makeContext('2.2.2.2', 'signup'))).toBe(true);
    expect(() => signup.canActivate(makeContext('2.2.2.2', 'signup'))).toThrow(HttpException);
    vi.advanceTimersByTime(601_000);
    expect(signup.canActivate(makeContext('2.2.2.2', 'signup'))).toBe(true);
    vi.useRealTimers();
  });
});
