import { Body, Controller, Get, Inject, Module, Post, Query, Redirect, Req, UseGuards } from '@nestjs/common';
import {
  RATE_LIMITS,
  changePasswordDto,
  findIdDto,
  loginDto,
  recoverPasswordDto,
  signupDto,
  type MeView,
} from '@workfluence/shared';
import type { Request } from 'express';
import 'express-session';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { RateLimit, RateLimitGuard, RateLimitStore } from '../common/rate-limit.guard';
import { ZodPipe } from '../common/zod.pipe';
import { UsersModule } from '../users/users.module';
import { AllowPendingPasswordChange, AuthGuard, CurrentUser, Public, type SessionUser } from './auth.guard';
import { AuthService, toMeView } from './auth.service';
import { HttpOidcProvider } from './oidc/http.provider';
import { MockOidcProvider } from './oidc/mock.provider';
import { OIDC_PROVIDER } from './oidc/oidc.provider';

/** 세션에 사용자를 심고 **ID를 재발급**한다 (FR-225 — 세션 고정 공격 방지) */
async function startSession(req: Request, userId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.userId = userId;
  req.session.createdAt = Date.now();
  await new Promise<void>((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
}

@Controller('api/auth')
@UseGuards(AuthGuard, RateLimitGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    // **가드가 아니라 저장소를 주입받는다.** 가드는 Nest가 provider와 별개로 만들어서
    // 여기서 가드를 받으면 요청을 센 인스턴스와 다른 것이 온다 — 환불이 조용히 사라진다 (T-027)
    private readonly rateLimit: RateLimitStore,
  ) {}

  @Post('login')
  @Public()
  @RateLimit(RATE_LIMITS.login)
  async login(@Body(new ZodPipe(loginDto)) dto: ReturnType<typeof loginDto.parse>, @Req() req: Request): Promise<MeView> {
    const user = await this.auth.login(dto, req.ip);
    await startSession(req, user.id);
    // **성공했으므로 제한 예산을 돌려준다.** 무차별 대입을 막는 것이 목적이니 실패만 세면 된다 (T-023)
    this.rateLimit.refund(req);
    return toMeView(user);
  }

  @Post('logout')
  @AllowPendingPasswordChange()
  async logout(@Req() req: Request): Promise<{ ok: true }> {
    const userId = req.session.userId;
    await this.auth.logout(userId, req.ip);
    // 서버측 세션을 **파기**한다 (FR-224). 쿠키만 지우면 훔친 세션이 계속 산다
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    return { ok: true };
  }

  @Get('me')
  @AllowPendingPasswordChange()
  me(@CurrentUser() user: SessionUser): MeView {
    return user;
  }

  /** 화면이 OIDC 버튼을 보일지 정하는 데 쓴다 (FR-219) */
  @Get('config')
  @Public()
  config(): { oidcEnabled: boolean; collabEnabled: boolean } {
    // 실시간 편집 여부를 화면이 알아야 한다 (FR-711). 꺼져 있으면 단독 편집기를 띄운다 —
    // 화면이 모르면 WebSocket을 열려다 실패하고 사용자는 이유를 알 수 없다
    return { oidcEnabled: this.env.WF_OIDC_ENABLED, collabEnabled: this.env.WF_COLLAB_ENABLED };
  }

  @Post('signup')
  @Public()
  @RateLimit(RATE_LIMITS.signup)
  async signup(@Body(new ZodPipe(signupDto)) dto: ReturnType<typeof signupDto.parse>, @Req() req: Request): Promise<{ ok: true }> {
    await this.auth.signup(dto, req.ip);
    return { ok: true };
  }

  @Post('find-id')
  @Public()
  @RateLimit(RATE_LIMITS.findId)
  findId(@Body(new ZodPipe(findIdDto)) dto: ReturnType<typeof findIdDto.parse>, @Req() req: Request): Promise<{ username: string | null }> {
    return this.auth.findId(dto, req.ip);
  }

  @Post('recover-password')
  @Public()
  @RateLimit(RATE_LIMITS.recoverPassword)
  recoverPassword(
    @Body(new ZodPipe(recoverPasswordDto)) dto: ReturnType<typeof recoverPasswordDto.parse>,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.auth.recoverPassword(dto, req.ip);
  }

  /** 비밀번호 변경은 변경 강제 상태에서도 되어야 한다 — 아니면 빠져나올 방법이 없다 (FR-207) */
  @Post('change-password')
  @AllowPendingPasswordChange()
  async changePassword(
    @Body(new ZodPipe(changePasswordDto)) dto: ReturnType<typeof changePasswordDto.parse>,
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.auth.changePassword(user.id, dto, req.ip);
    // 서비스가 그 사용자의 **모든** 세션을 이미 끊었다 (FR-224). 지금 요청만 새 세션으로 다시 심는다
    await startSession(req, user.id);
    return { ok: true };
  }

  // ---- OIDC ----

  @Get('oidc/start')
  @Public()
  @Redirect()
  async oidcStart(@Req() req: Request): Promise<{ url: string }> {
    const { url, state, nonce, verifier } = await this.auth.oidcStart();
    req.session.oidcState = state;
    req.session.oidcNonce = nonce;
    req.session.oidcVerifier = verifier;
    await new Promise<void>((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
    return { url };
  }

  @Get('oidc/callback')
  @Public()
  @Redirect()
  async oidcCallback(@Query('code') code: string, @Query('state') state: string, @Req() req: Request): Promise<{ url: string }> {
    const saved = { state: req.session.oidcState, nonce: req.session.oidcNonce, verifier: req.session.oidcVerifier };
    const user = await this.auth.oidcCallback({ code, state }, saved, req.ip);
    await startSession(req, user.id);
    return { url: '/' };
  }
}

/**
 * 인증 모듈.
 *
 * OIDC 제공자는 설정으로 고른다 (DIP — P1_설계서_Auth 0.1절). 꺼져 있으면 `null`을 주입하고
 * 서비스가 404를 낸다. **운영 이미지에는 WF_OIDC_MOCK을 넘기지 않으므로** 모의 제공자가
 * 선택될 경로 자체가 없다 (compose.yml 주석).
 */
@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    // 센 것을 담는 저장소는 **provider 하나**다. 가드가 몇 개로 만들어지든 예산은 하나다 (T-027)
    RateLimitStore,
    RateLimitGuard,
    MockOidcProvider,
    HttpOidcProvider,
    {
      provide: OIDC_PROVIDER,
      inject: [APP_ENV, MockOidcProvider, HttpOidcProvider],
      useFactory: (env: AppEnvToken, mock: MockOidcProvider, http: HttpOidcProvider) =>
        !env.WF_OIDC_ENABLED ? null : env.WF_OIDC_MOCK ? mock : http,
    },
  ],
})
export class AuthModule {}
