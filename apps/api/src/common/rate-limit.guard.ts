import { CanActivate, type ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

/**
 * 공개 엔드포인트(가입·ID 찾기·비밀번호 찾기·로그인) IP별 요청 제한. 단일 인스턴스 프로토타입이라 메모리에 둔다.
 * 이중화(보류 6)가 되면 PG나 공유 저장소로 옮긴다.
 */
export type RateLimitSpec = { max: number; windowSec: number };
const KEY = 'wf:rate-limit';
export const RateLimit = (spec: RateLimitSpec) => SetMetadata(KEY, spec);

/**
 * 요청에 붙여 두는 자기 몫. 성공했을 때 **그 한 건만** 돌려준다.
 *
 * 키만 기억하고 "가장 최근 것을 뺀다"로 하면 두 번 부르거나 동시에 들어온 다른 요청의
 * 몫까지 지운다 — 테스트가 그것을 잡았다. 그래서 찍힌 시각을 그대로 들고 있다가 그 값을 뺀다.
 */
const REQ_MARK = Symbol('wf:rate-limit-mark');
type Marked = Request & { [REQ_MARK]?: { key: string; at: number } };

/**
 * **센 것을 가드가 아니라 여기에 둔다** (T-027).
 *
 * Nest는 `@UseGuards(RateLimitGuard)`의 가드를 **provider와 별개의 인스턴스로** 만든다.
 * 상태를 가드 안에 두면, 요청을 센 가드와 컨트롤러가 주입받아 환불을 부르는 가드가
 * 서로 다른 Map을 본다 — 환불이 조용히 아무 일도 하지 않는다. 실제로 그랬고,
 * 단위 테스트는 가드 하나만 만들어 쓰므로 잡지 못했다.
 *
 * 상태를 밖으로 빼면 **가드가 몇 개가 되든 예산은 하나다.** 조립 방식이 바뀌어도 깨지지 않는다.
 */
@Injectable()
export class RateLimitStore {
  /**
   * 키마다 **자기 창 길이를 함께** 들고 있다.
   *
   * 예전에는 값이 시각 배열뿐이었고, 청소가 **지금 들어온 요청의 창**으로 모든 키를
   * 판정했다. 로그인(60초) 요청 하나가 들어오면 가입·비밀번호 찾기(600초) 키 중
   * 최근 60초에 히트가 없는 것을 통째로 지웠다 — **평범한 로그인 트래픽이 가입 제한을
   * 조용히 리셋한다.** 무차별 대입을 막으려고 둔 장치가 트래픽만 있으면 풀리는 것이다.
   */
  private readonly hits = new Map<string, { windowMs: number; at: number[] }>();
  private lastSweep = Date.now();

  /** 한 건을 센다. 상한을 넘었으면 `false` */
  hit(req: Request, key: string, spec: RateLimitSpec): boolean {
    const now = Date.now();
    const windowMs = spec.windowSec * 1000;

    // 청소는 **각 키의 자기 창**으로 판정한다. 가장 짧은 창(60초)마다 한 번 훑는다
    if (now - this.lastSweep > 60_000) {
      for (const [k, e] of this.hits) if (!e.at.some((t) => now - t < e.windowMs)) this.hits.delete(k);
      this.lastSweep = now;
    }

    const recent = (this.hits.get(key)?.at ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= spec.max) return false;
    recent.push(now);
    this.hits.set(key, { windowMs, at: recent });
    (req as Marked)[REQ_MARK] = { key, at: now };
    return true;
  }

  /**
   * **성공한 요청은 제한 예산을 쓰지 않는다.**
   *
   * 무차별 대입을 막는 것이 이 제한의 목적인데, 세는 것이 "시도 전부"였다. 그러면 사내 NAT
   * 뒤에서 여럿이 정상 로그인하는 것만으로 한도가 찬다 — 300명이 한 주소로 나가는 환경에서
   * 분당 20회는 쉽게 넘는다. 실제로 E2E가 그 벽에 먼저 부딪혔다 (T-023).
   * 실패만 세면 공격자는 여전히 막히고 정상 사용자는 막히지 않는다.
   */
  refund(req: Request): void {
    const mark = (req as Marked)[REQ_MARK];
    if (!mark) return;
    delete (req as Marked)[REQ_MARK]; // 두 번 불러도 한 번만 돌려준다
    const e = this.hits.get(mark.key);
    if (!e) return;
    const i = e.at.lastIndexOf(mark.at);
    if (i >= 0) e.at.splice(i, 1);
  }

  /** 테스트용 — 남은 건수 */
  countFor(key: string): number {
    return this.hits.get(key)?.at.length ?? 0;
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitStore,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const spec = this.reflector.get<RateLimitSpec | undefined>(KEY, ctx.getHandler());
    if (!spec) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = `${ctx.getClass().name}.${ctx.getHandler().name}:${req.ip ?? 'unknown'}`;
    if (!this.store.hit(req, key, spec)) {
      throw new HttpException(
        `요청이 너무 잦다. ${Math.ceil(spec.windowSec / 60)}분 후 다시 시도한다`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
