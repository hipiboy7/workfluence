import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Ip,
  Module,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  RATE_LIMITS,
  SETTINGS_KEYS,
  changePasswordDto,
  findIdDto,
  loginDto,
  maskEmail,
  maskUsername,
  recoverPasswordDto,
  signupDto,
  type ChangePasswordDto,
  type ContactInfoView,
  type FindIdDto,
  type LoginDto,
  type MeView,
  type RecoverPasswordDto,
  type Role,
  type SignupDto,
} from '@workfluence/shared';
import type { Request } from 'express';
import { AuditModule, AuditService } from '../audit/audit.module';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import { ZodPipe } from '../common/zod.pipe';
import { SettingsService } from '../settings/settings.module';
import { UsersService } from '../users/users.service';
import { AllowPendingPasswordChange, AuthGuard, CurrentUser, type SessionUser } from './auth.guard';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toMe(u: { id: string; username: string; displayName: string; role: string; mustChangePassword: boolean }): MeView {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role as Role, mustChangePassword: u.mustChangePassword };
}

@Controller('api/auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @RateLimit(RATE_LIMITS.login)
  async login(@Body(new ZodPipe(loginDto)) dto: LoginDto, @Req() req: Request, @Ip() ip: string): Promise<MeView> {
    const result = await this.users.verifyCredentials(dto.username, dto.password);
    if (!result.ok) {
      await this.audit.record({ action: 'auth.login.failure', detail: { username: dto.username, reason: result.reason }, ip });
      if (result.reason === 'pending') throw new ForbiddenException('승인 대기 중인 계정이다. 관리자 승인 후 로그인할 수 있다');
      // 없는 계정/틀린 비밀번호/잠김을 구분해 알려주지 않는다 — 계정 열거 방지
      throw new UnauthorizedException('사용자명 또는 비밀번호가 올바르지 않다');
    }
    const user = result.user;
    // 세션 고정 공격 방지: 로그인 시 세션 ID 재발급
    await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.userId = user.id;
    req.session.createdAt = Date.now();
    await this.audit.record({ action: 'auth.login.success', actorId: user.id, ip });
    return toMe(user);
  }

  /** 신규 가입 → 승인 대기 */
  @Post('signup')
  @RateLimit(RATE_LIMITS.signup)
  async signup(@Body(new ZodPipe(signupDto)) dto: SignupDto, @Ip() ip: string): Promise<{ message: string }> {
    const row = await this.users.signup(dto);
    await this.audit.record({ action: 'user.signup', targetType: 'user', targetId: row.id, detail: { username: row.username }, ip });
    return { message: '가입 요청이 접수됐다. 관리자 승인 후 로그인할 수 있다' };
  }

  /** ID 찾기: email + 이름 → 마스킹된 ID (prototype-v2 2절 3번) */
  @Post('find-id')
  @HttpCode(200)
  @RateLimit(RATE_LIMITS.findId)
  async findId(@Body(new ZodPipe(findIdDto)) dto: FindIdDto, @Ip() ip: string): Promise<{ maskedUsername: string }> {
    const user = await this.users.findByEmailAndName(dto.email, dto.displayName);
    await this.audit.record({ action: 'auth.id.recover', detail: { email: maskEmail(dto.email), found: !!user }, ip });
    if (!user) {
      await sleep(400);
      throw new NotFoundException('입력한 정보와 일치하는 계정이 없다');
    }
    return { maskedUsername: maskUsername(user.username) };
  }

  /** PWD 찾기: ID + email → 임시 비밀번호 1회 표시, 다음 로그인에서 변경 강제 */
  @Post('recover-password')
  @HttpCode(200)
  @RateLimit(RATE_LIMITS.recoverPassword)
  async recoverPassword(@Body(new ZodPipe(recoverPasswordDto)) dto: RecoverPasswordDto, @Ip() ip: string): Promise<{ temporaryPassword: string; message: string }> {
    const result = await this.users.recoverPassword(dto.username, dto.email);
    await this.audit.record({
      action: 'auth.password.recover',
      targetType: 'user',
      targetId: result?.user.id ?? null,
      detail: { username: dto.username, email: maskEmail(dto.email), found: !!result },
      ip,
    });
    if (!result) {
      await sleep(400);
      throw new NotFoundException('입력한 정보와 일치하는 계정이 없다');
    }
    return { temporaryPassword: result.temporaryPassword, message: '임시 비밀번호로 로그인하면 바로 새 비밀번호를 설정해야 한다' };
  }

  @Post('change-password')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @AllowPendingPasswordChange()
  async changePassword(@Body(new ZodPipe(changePasswordDto)) dto: ChangePasswordDto, @CurrentUser() user: SessionUser, @Ip() ip: string): Promise<void> {
    await this.users.changePassword(user.id, dto.currentPassword, dto.newPassword);
    await this.audit.record({ action: 'auth.password.change', actorId: user.id, ip });
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @AllowPendingPasswordChange()
  async logout(@Req() req: Request, @CurrentUser() user: SessionUser, @Ip() ip: string): Promise<void> {
    await this.audit.record({ action: 'auth.logout', actorId: user.id, ip });
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @AllowPendingPasswordChange()
  me(@CurrentUser() user: SessionUser): MeView {
    return toMe(user);
  }

  /** 담당자 확인: 관리자가 편집한 안내문 + admin 이름 목록 (email 미노출) */
  @Get('contact')
  async contact(): Promise<ContactInfoView> {
    const message = await this.settings.get<string>(SETTINGS_KEYS.contactInfo, '계정·권한 문의는 아래 관리자에게 연락하세요.');
    return { message, admins: await this.users.adminDisplayNames() };
  }
}

@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [AuthGuard, RateLimitGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
