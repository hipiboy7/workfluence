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

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(private readonly reflector: Reflector) {}

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
    return true;
  }
}
