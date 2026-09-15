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
import { can, type Action, type Role } from '@workfluence/shared';
import type { Request } from 'express';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { UsersService } from '../users/users.service';

export type SessionUser = { id: string; username: string; displayName: string; role: Role; mustChangePassword: boolean };

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    /** 세션 생성 시각(ms). 절대 타임아웃 판정용 (CLAUDE.md 7절) */
    createdAt?: number;
  }
}

const ACTION_KEY = 'wf:action';
const ALLOW_PENDING_PW_KEY = 'wf:allow-pending-password';

/** 핸들러가 요구하는 행위. AuthGuard가 shared의 can()으로 판정한다 — 권한 판정은 한 곳에서 (CLAUDE.md 7절) */
export const RequireAction = (action: Action) => SetMetadata(ACTION_KEY, action);
/** 비밀번호 변경이 강제된 상태에서도 허용하는 핸들러 (me, change-password, logout) */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PW_KEY, true);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): SessionUser => {
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
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const session = req.session;
    if (!session?.userId) throw new UnauthorizedException('로그인이 필요하다');

    const absoluteMs = this.env.WF_SESSION_ABSOLUTE_HOURS * 3600_000;
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

    const allowPending = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_PENDING_PW_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (user.mustChangePassword && !allowPending) {
      throw new ForbiddenException({ code: 'PASSWORD_CHANGE_REQUIRED', message: '비밀번호를 변경해야 계속할 수 있다' });
    }

    const action = this.reflector.getAllAndOverride<Action | undefined>(ACTION_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (action && !can(req.user, action)) throw new ForbiddenException(`권한이 없다: ${action}`);
    return true;
  }
}
