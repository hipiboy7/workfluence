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

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(private readonly reflector: Reflector) {}

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
    const arr = this.hits.get(mark.key);
    if (!arr) return;
    const i = arr.lastIndexOf(mark.at);
    if (i >= 0) arr.splice(i, 1);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const spec = this.reflector.get<RateLimitSpec | undefined>(KEY, ctx.getHandler());
    if (!spec) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = `${ctx.getClass().name}.${ctx.getHandler().name}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const windowMs = spec.windowSec * 1000;

    if (now - this.lastSweep > windowMs) {
      for (const [k, arr] of this.hits) if (!arr.some((t) => now - t < windowMs)) this.hits.delete(k);
      this.lastSweep = now;
    }

    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= spec.max) {
      throw new HttpException(`요청이 너무 잦다. ${Math.ceil(windowMs / 60000)}분 후 다시 시도한다`, HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.hits.set(key, recent);
    (req as Marked)[REQ_MARK] = { key, at: now };
    return true;
  }
}
