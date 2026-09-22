import {
  CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_HEADER, can, type Action, type Role } from '@workfluence/shared';
import type { Request } from 'express';
// 타입 확장(declare module)을 하려면 그 모듈이 먼저 로드돼야 한다. Request.session도 여기서 붙는다
import 'express-session';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';

/**
 * 인증·권한 가드 (P1_설계서_Auth 0절·4절·7절).
 *
 * **가드는 판정하지 않는다.** 데이터를 모아 `shared`의 `can()`에 넘기고 결과만 쓴다.
 * 판정 규칙이 한 곳에 있어야 화면과 서버가 어긋나지 않는다 (CLAUDE.md 7절).
 */

export type SessionUser = { id: string; username: string; displayName: string; role: Role; mustChangePassword: boolean };

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    /** 세션 생성 시각(ms). 절대 타임아웃 판정용 (FR-223) */
    createdAt?: number;
    /** OIDC 왕복에 쓰는 일회용 값 (FR-211) */
    oidcState?: string;
    oidcNonce?: string;
    oidcVerifier?: string;
  }
}

const ACTION_KEY = 'wf:action';
const ALLOW_PENDING_PW_KEY = 'wf:allow-pending-password';
const PUBLIC_KEY = 'wf:public';

/** 핸들러가 요구하는 행위. 선언하지 않으면 로그인만 확인한다 */
export const RequireAction = (action: Action) => SetMetadata(ACTION_KEY, action);
/** 비밀번호 변경이 강제된 상태에서도 허용 (me·change-password·logout) */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PW_KEY, true);
/** 로그인 없이 접근 (login·signup·계정 찾기) */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): SessionUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
  if (!req.user) throw new UnauthorizedException();
  return req.user;
});

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersService,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    private readonly settings: SettingsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const session = req.session;
    if (!session?.userId) throw new UnauthorizedException('로그인이 필요하다');

    // 절대 타임아웃은 쿠키 maxAge로 못 지킨다 — rolling이 갱신해 버린다 (FR-223)
    // **운영이 조절한 값을 쓴다** (FR-521). 기동 시점 값이 아니라 지금 값이다
    const policy = await this.settings.get();
    // 유휴 시간은 쿠키 maxAge다. 기동 시점에 한 번 정해지므로 **요청마다 다시 얹는다** —
    // 안 그러면 관리 화면에서 바꿔도 이미 뜬 서버에서는 영영 안 먹는다
    if (session.cookie) session.cookie.maxAge = policy.sessionIdleMinutes * 60_000;
    const absoluteMs = policy.sessionAbsoluteHours * 3600_000;
    if (!session.createdAt || Date.now() - session.createdAt > absoluteMs) {
      await new Promise<void>((resolve) => session.destroy(() => resolve()));
      throw new UnauthorizedException('세션이 만료됐다 (절대 타임아웃)');
    }

    const user = await this.users.findById(session.userId);
    if (!user || user.status !== 'active') {
      await new Promise<void>((resolve) => session.destroy(() => resolve()));
      throw new UnauthorizedException('사용 가능한 계정이 아니다');
    }
    req.user = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role as Role,
      mustChangePassword: user.mustChangePassword,
    };

    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PW_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (user.mustChangePassword && !allowPending) {
      throw new ForbiddenException({ code: 'PASSWORD_CHANGE_REQUIRED', message: '비밀번호를 변경해야 계속할 수 있다' });
    }

    const action = this.reflector.getAllAndOverride<Action | undefined>(ACTION_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (action && !can(req.user, action)) throw new ForbiddenException(`권한이 없다: ${action}`);
    return true;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF 가드 (FR-240). 상태 변경 요청에 커스텀 헤더를 요구한다.
 *
 * **값이 아니라 헤더의 존재가 방어다.** 교차 출처에서 커스텀 헤더를 붙이면 preflight가 걸리고,
 * 우리 서버는 그 preflight를 허용하지 않는다. 그래서 값을 비밀로 둘 필요가 없다.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!MUTATING.has(req.method)) return true;
    if (!req.headers[CSRF_HEADER]) throw new ForbiddenException(`${CSRF_HEADER} 헤더가 필요하다`);
    return true;
  }
}
