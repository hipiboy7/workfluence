import { Body, Controller, Get, Inject, Logger, Module, NotFoundException, Post, Query, Redirect, Req, UseGuards } from '@nestjs/common';
import {
  RATE_LIMITS,
  changePasswordDto,
  emailHelpDto,
  findIdDto,
  loginDto,
  recoverPasswordDto,
  resetPasswordDto,
  signupDto,
  type MeView,
  type PasswordRulesView,
} from '@workfluence/shared';
import type { Request } from 'express';
import 'express-session';
import { logLine } from '../common/log-line';
import { RevocationBus } from '../common/revocation.bus';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { RateLimit, RateLimitGuard, RateLimitStore } from '../common/rate-limit.guard';
import { ZodPipe } from '../common/zod.pipe';
import { UsersModule } from '../users/users.module';
import { SettingsService } from '../settings/settings.service';
import { AllowPendingPasswordChange, AuthGuard, CurrentUser, Public, type SessionUser } from './auth.guard';
import { AuthService, toMeView } from './auth.service';
import { HttpOidcProvider } from './oidc/http.provider';
import { MockOidcProvider } from './oidc/mock.provider';
import { OIDC_PROVIDER } from './oidc/oidc.provider';
import { RecoveryService } from './recovery.service';

/** 메일 재설정을 쓰지 않을 때 (P19 FR-2008) — 화면은 단추를 보이지 않는다. 이미 보낸 링크도 여기로 온다(A.1-9) */
const RESET_MAIL_OFF = '메일로 비밀번호를 바꾸는 길을 쓰지 않는다 — 관리자에게 초기화를 요청한다';

/** 세션을 **새로 받는다** — 옛 행은 지우고 새 ID로 (`express-session`의 `regenerate`) */
function regenerate(req: Request): Promise<void> {
  return new Promise<void>((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
}

/**
 * 세션에 사용자를 심고 **ID를 재발급**한다 (FR-225 — 세션 고정 공격 방지).
 *
 * **행은 응답이 끝날 때 한 번 더 쓰인다** (좁은 자체 점검 7). `regenerate`가 준 새 세션은 `express-session`이 저장 여부를 가리는 표시를 달지
 * 않아, 여기서 저장해도 응답 끝에 같은 행을 다시 쓴다(있으면 고치고 없으면 넣는다). 로그인은 이것을 계정의 줄 안에서 부르지만 그 두 번째 쓰기는
 * 줄 밖이다 — 지금은 줄에서 기다리던 비밀번호 변경이 세션을 지우기까지 argon2를 두 번 돌아(약 0.3초) 그 쓰기가 늘 먼저 끝난다. **변경의
 * argon2를 줄 밖으로 빼면 이 틈이 다시 열린다** (`AuthService.login`). 메일 링크로 새 비밀번호를 정할 때도 같다 — 해시를 줄 안에서 만든다
 * (`RecoveryService.resetPassword`, P19 병합 전 보안 검토 1)
 */
async function startSession(req: Request, userId: string): Promise<void> {
  await regenerate(req);
  req.session.userId = userId;
  req.session.createdAt = Date.now();
  await new Promise<void>((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
}

@Controller('api/auth')
@UseGuards(AuthGuard, RateLimitGuard)
export class AuthController {
  private readonly log = new Logger('Auth');

  constructor(
    private readonly auth: AuthService,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    // **가드가 아니라 저장소를 주입받는다.** 가드는 Nest가 provider와 별개로 만들어서
    // 여기서 가드를 받으면 요청을 센 인스턴스와 다른 것이 온다 — 환불이 조용히 사라진다 (T-027)
    private readonly rateLimit: RateLimitStore,
    private readonly revocation: RevocationBus,
    private readonly settings: SettingsService,
    private readonly recovery: RecoveryService,
  ) {}

  @Post('login')
  @Public()
  @RateLimit(RATE_LIMITS.login)
  async login(@Body(new ZodPipe(loginDto)) dto: ReturnType<typeof loginDto.parse>, @Req() req: Request): Promise<MeView> {
    // 세션은 **그 계정의 줄 안에서** 만든다 — 비밀번호 변경과 엇갈리지 않게 (`AuthService.login`)
    const user = await this.auth.login(dto, req.ip, (u) => startSession(req, u.id));
    // **성공했으므로 제한 예산을 돌려준다.** 무차별 대입을 막는 것이 목적이니 실패만 세면 된다 (T-023)
    this.rateLimit.refund(req);
    return toMeView(user);
  }

  @Post('logout')
  @AllowPendingPasswordChange()
  async logout(@Req() req: Request): Promise<{ ok: true }> {
    const userId = req.session.userId;
    const sid = req.sessionID;
    await this.auth.logout(userId, req.ip);
    // 서버측 세션을 **파기**한다 (FR-224). 쿠키만 지우면 훔친 세션이 계속 산다
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    // **열려 있는 편집 연결도 끊는다** (P7 보안 검토 F1). 세션 행을 지우는 것만으로는
    // 부족하다 — 그 연결은 행을 다시 읽지 않는다. **이 세션의 것만** 끊는다: 로그아웃은
    // 누른 브라우저 하나의 일이고, 같은 사람의 다른 기기 편집을 끊을 이유가 없다
    if (userId) this.revocation.revoke(userId, sid);
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
  async config(): Promise<{ oidcEnabled: boolean; collabEnabled: boolean; resetMailEnabled: boolean }> {
    // 실시간 편집 여부를 화면이 알아야 한다 (FR-711). 꺼져 있으면 단독 편집기를 띄운다 —
    // 화면이 모르면 WebSocket을 열려다 실패하고 사용자는 이유를 알 수 없다.
    // 메일 재설정을 쓸 수 있는지도 준다(P19 FR-2008) — 아니면 비밀번호 찾기가 그 단추를 보이지 않는다
    return { oidcEnabled: this.env.WF_OIDC_ENABLED, collabEnabled: this.env.WF_COLLAB_ENABLED, resetMailEnabled: await this.resetMailOn() };
  }

  /**
   * 메일 재설정을 쓸 수 있나 — **운영 설정을 읽지 못하면 끈 것으로 답한다**(병합 전 코드 리뷰 5). 이 경로가 통째로 실패하면 편집 화면이 실시간 편집을
   * 모른 채 혼자 편집으로 떨어지고 로그인 화면이 사내 로그인 단추를 감춘다 — 두 값은 `.env`라 실패하지 않는다
   */
  private async resetMailOn(): Promise<boolean> {
    try {
      return await this.recovery.available();
    } catch (e) {
      this.log.error(logLine('auth.config_failed', '화면 설정에 메일 재설정을 싣지 못했다 — 끈 것으로 답한다', {}, e));
      return false;
    }
  }

  /**
   * **비밀번호 규칙** — 로그인 전에도 읽는다 (P13 FR-1472). 가입 화면은 로그인 전이라 운영 설정(`/api/settings/policy`)을 못 읽어 안내문을
   * 고정 문자열로 두었다. 길이와 문자 종류 수만 준다 — 잠금 기준·세션 시간은 잠금 회피 간격을 계산할 수 있는 값이라 주지 않는다(P4 자체 점검 11)
   */
  @Get('password-rules')
  @Public()
  async passwordRules(): Promise<PasswordRulesView> {
    const p = await this.settings.get();
    return { minLength: p.passwordMinLength, minCharClasses: p.passwordMinCharClasses };
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

  /**
   * **내 email로 재설정 링크** (P19 FR-2002). 응답은 곧바로, 늘 같다 — 맞는지·보냈는지는 응답 뒤에 가린다(NFR-191). 쓰지 않으면 404(FR-2008)
   */
  @Post('reset-mail')
  @Public()
  @RateLimit(RATE_LIMITS.resetMail)
  async resetMail(@Body(new ZodPipe(recoverPasswordDto)) dto: ReturnType<typeof recoverPasswordDto.parse>, @Req() req: Request): Promise<{ ok: true }> {
    if (!(await this.recovery.available())) throw new NotFoundException(RESET_MAIL_OFF);
    this.recovery.startResetMail(dto, req.ip);
    return { ok: true };
  }

  /**
   * **링크로 새 비밀번호** (P19 FR-2006). 로그인은 따로 한다 — 링크를 누른 브라우저가 그 사람의 것이라는 근거가 메일함뿐이다(A.1-10). 쓰지 않으면 404 —
   * 이미 보낸 링크도 막는다(A.1-9)
   */
  @Post('reset-password')
  @Public()
  @RateLimit(RATE_LIMITS.resetPassword)
  async resetPassword(@Body(new ZodPipe(resetPasswordDto)) dto: ReturnType<typeof resetPasswordDto.parse>, @Req() req: Request): Promise<{ ok: true }> {
    if (!(await this.recovery.available())) throw new NotFoundException(RESET_MAIL_OFF);
    await this.recovery.resetPassword(dto, req.ip);
    return { ok: true };
  }

  /** **"이메일이 기억이 안나시나요?"** (P19 FR-2009) — 아이디 + 표시 이름. 응답은 곧바로, 늘 같다 */
  @Post('email-help')
  @Public()
  @RateLimit(RATE_LIMITS.emailHelp)
  emailHelp(@Body(new ZodPipe(emailHelpDto)) dto: ReturnType<typeof emailHelpDto.parse>, @Req() req: Request): { ok: true } {
    this.recovery.startEmailHelp(dto, req.ip);
    return { ok: true };
  }

  /**
   * 비밀번호 변경은 변경 강제 상태에서도 되어야 한다 — 아니면 빠져나올 방법이 없다 (FR-207).
   *
   * **IP별로 센다** (좁은 자체 점검 6). 변경은 그 계정의 로그인과 같은 줄에 선다(`AuthService.changePassword`) — 세지 않으면 세션을 쥔 사람이
   * 틀린 현재 비밀번호를 거듭 보내 그 계정의 로그인과, 침해를 알아채고 하는 바로 이 변경을 뒤로 민다. 성공은 돌려준다(로그인과 같다)
   */
  @Post('change-password')
  @AllowPendingPasswordChange()
  @RateLimit(RATE_LIMITS.changePassword)
  async changePassword(
    @Body(new ZodPipe(changePasswordDto)) dto: ReturnType<typeof changePasswordDto.parse>,
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.auth.changePassword(user.id, dto, req.ip);
    this.rateLimit.refund(req);
    // 서비스가 그 사용자의 **모든** 세션을 이미 끊었다 (FR-224). 지금 요청만 새 세션으로 다시 심는다
    await startSession(req, user.id);
    return { ok: true };
  }

  // ---- OIDC ----

  /**
   * 사내 IdP로 보낸다. **세션을 새로 받고 거기에 일회용 값을 둔다** (좁은 자체 점검 3). 불러온 세션에 값을 넣고 저장하면, 저장소는 그 행을
   * "있으면 고치고 없으면 넣는다" — 그 사이 비밀번호 변경·강제 종료·정지가 지운 세션이 사용자 ID째로 되살아났다(훔친 쿠키로 이것을 거듭
   * 부르면 된다). 새로 받은 세션에는 사용자가 없다 — 로그인한 채 부르면 그 브라우저는 로그아웃된다(새로 로그인하는 길이다)
   */
  @Get('oidc/start')
  @Public()
  @Redirect()
  async oidcStart(@Req() req: Request): Promise<{ url: string }> {
    const { url, state, nonce, verifier } = await this.auth.oidcStart();
    await regenerate(req);
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
    RecoveryService,
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
