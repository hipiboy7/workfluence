import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, requiredScopes, scopeAllows, type Action, type ApiTokenScope } from '@workfluence/shared';
import type { Request } from 'express';
import { ACTION_KEY, PUBLIC_KEY, type SessionUser } from '../auth/auth.guard';
import { setRequestToken, setRequestUser } from '../common/request-context';
import { parseBearer } from './domain/jwt';
import { ApiTokensService } from './api-tokens.service';

const API_ADMIN_KEY = 'wf:api-admin';

/** 관리 경로 — 토큰에 `admin` scope가 **더** 있어야 한다 (계획서 Q4) */
export const ApiAdminRoute = () => SetMetadata(API_ADMIN_KEY, true);

export type ApiTokenRequest = Request & { user?: SessionUser; apiToken?: { id: string; scopes: ApiTokenScope[] } };

const fail = (Ctor: new (body: object) => HttpException, code: string, message: string) => new Ctor({ code, message });

/**
 * 공개 API 가드 (docs/spinoff/public-api 계획서 4.1·4.2절).
 *
 * **세션을 보지 않는다.** 쿠키가 있어도 Bearer가 없으면 401이다 — 그래서 `/api/v1`에는 CSRF가 닿지 않는다(`CsrfGuard`가 이 경로를 빼 준다).
 * 순서: 토큰 → scope → 사람의 권한(`can()`). 토큰은 사람의 권한을 **줄이기만** 한다.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: ApiTokensService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<ApiTokenRequest>();
    const jwt = parseBearer(req.headers.authorization);
    if (!jwt) throw fail(UnauthorizedException, 'TOKEN_MISSING', 'Authorization: Bearer <토큰>이 필요하다');

    const r = await this.tokens.authenticate(jwt);
    if (!r.ok) {
      if (r.code === 'API_DISABLED') throw fail(ServiceUnavailableException, r.code, '공개 API가 꺼져 있다');
      if (r.code === 'PASSWORD_CHANGE_REQUIRED') throw fail(ForbiddenException, r.code, '화면에서 비밀번호를 바꿔야 토큰을 쓸 수 있다');
      throw fail(UnauthorizedException, r.code, '토큰을 쓸 수 없다');
    }
    req.user = r.user;
    req.apiToken = { id: r.tokenId, scopes: r.scopes };
    setRequestUser(r.user.id);
    setRequestToken(r.tokenId);

    const admin = this.reflector.getAllAndOverride<boolean>(API_ADMIN_KEY, targets) ?? false;
    const required = requiredScopes(req.method, admin);
    if (!scopeAllows(r.scopes, required)) {
      throw fail(ForbiddenException, 'INSUFFICIENT_SCOPE', `이 요청에는 토큰 scope ${required.join('·')}가 필요하다`);
    }

    const action = this.reflector.getAllAndOverride<Action | undefined>(ACTION_KEY, targets);
    if (action && !can(r.user, action)) throw fail(ForbiddenException, 'FORBIDDEN', `권한이 없다: ${action}`);
    return true;
  }
}
