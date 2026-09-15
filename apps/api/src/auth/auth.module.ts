import { Body, Controller, Get, HttpCode, Ip, Module, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { loginDto, type LoginDto, type UserView } from '@workfluence/shared';
import type { Request } from 'express';
import { AuditModule, AuditService } from '../audit/audit.module';
import { ZodPipe } from '../common/zod.pipe';
import { UsersModule } from '../users/users.module';
import { UsersService, toUserView } from '../users/users.service';
import { AuthGuard, CurrentUser, type SessionUser } from './auth.guard';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginDto)) dto: LoginDto, @Req() req: Request, @Ip() ip: string): Promise<UserView> {
    const result = await this.users.verifyCredentials(dto.username, dto.password);
    if (!result.ok) {
      await this.audit.record({ action: 'auth.login.failure', detail: { username: dto.username, reason: result.reason }, ip });
      // 사유(없는 사용자/틀린 비밀번호/잠김)를 구분해 알려주지 않는다 — 계정 열거 방지
      throw new UnauthorizedException('사용자명 또는 비밀번호가 올바르지 않다');
    }
    const user = result.user;
    // 세션 고정 공격 방지: 로그인 시 세션 ID 재발급
    await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.userId = user.id;
    req.session.createdAt = Date.now();
    await this.audit.record({ action: 'auth.login.success', actorId: user.id, ip });
    return toUserView(user);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(@Req() req: Request, @CurrentUser() user: SessionUser, @Ip() ip: string): Promise<void> {
    await this.audit.record({ action: 'auth.logout', actorId: user.id, ip });
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: SessionUser): SessionUser {
    return user;
  }
}

@Module({
  imports: [UsersModule, AuditModule],
  controllers: [AuthController],
  providers: [AuthGuard],
  exports: [AuthGuard, UsersModule],
})
export class AuthModule {}
