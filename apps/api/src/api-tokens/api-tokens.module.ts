import { Body, Controller, Delete, Get, Module, Param, Post, Req, UseGuards } from '@nestjs/common';
import { API_TOKEN_LIMITS, API_TOKEN_SCOPES, createApiTokenDto, type ApiTokenView, type CreateApiTokenDto } from '@workfluence/shared';
import type { Request } from 'express';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { UsersModule } from '../users/users.module';
import { RateLimitStore } from '../common/rate-limit.guard';
import { ApiRateLimitGuard } from './api-rate-limit.guard';
import { ApiTokenGuard } from './api-token.guard';
import { ApiTokensService } from './api-tokens.service';

/**
 * 토큰 관리 — **화면(세션)에서만** (계획서 4.1절). 토큰으로 토큰을 만들지 못한다: 새어 나간 토큰이 스스로를 늘리는 길을 막는다.
 * 그래서 이 경로는 `/api/v1` 밖이고 세션 가드(`AuthGuard`)·CSRF 헤더를 그대로 쓴다.
 */
@Controller('api/tokens')
@UseGuards(AuthGuard)
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  /** 화면이 켜짐·상한을 보고 폼을 그린다 */
  @Get('config')
  config(): { enabled: boolean; scopes: readonly string[]; maxDays: number; defaultDays: number; maxPerUser: number } {
    return {
      enabled: this.tokens.enabled,
      scopes: API_TOKEN_SCOPES,
      maxDays: API_TOKEN_LIMITS.maxDays,
      defaultDays: API_TOKEN_LIMITS.defaultDays,
      maxPerUser: API_TOKEN_LIMITS.maxPerUser,
    };
  }

  @Get()
  list(@CurrentUser() me: SessionUser): Promise<ApiTokenView[]> {
    return this.tokens.list(me.id);
  }

  /** 값(`token`)은 이 응답에만 있다 — 다시 보이지 않는다 */
  @Post()
  async create(
    @Body(new ZodPipe(createApiTokenDto)) dto: CreateApiTokenDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<ApiTokenView & { token: string }> {
    const { token, view } = await this.tokens.create(me.id, dto, req.ip ?? null);
    return { ...view, token };
  }

  @Delete(':id')
  revoke(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<ApiTokenView> {
    return this.tokens.revoke(me.id, id, req.ip ?? null);
  }
}

/**
 * 사용자 관리에서 **그 사람의** 토큰을 보고 폐기한다 (FR-2222). 화면(세션)용이고 `user.manage`가 있어야 하며, 그 사람을 관리할 수 있어야 한다
 * (역할과 위임 — `UsersService.assertManageable`). 값은 어디에도 없다 — 새어 나간 토큰을 죽이는 일이지 꺼내 보는 일이 아니다
 */
@Controller('api/users/:id/tokens')
@UseGuards(AuthGuard)
export class UserApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get()
  @RequireAction('user.manage')
  list(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser): Promise<ApiTokenView[]> {
    return this.tokens.listForUser(actor, id);
  }

  @Delete(':tokenId')
  @RequireAction('user.manage')
  revoke(@Param('id', UuidPipe) id: string, @Param('tokenId', UuidPipe) tokenId: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<ApiTokenView> {
    return this.tokens.revokeForUser(actor, id, tokenId, req.ip ?? null);
  }
}

/** 공개 API 토큰 (docs/spinoff/public-api 계획서 4.1절) */
@Module({
  imports: [UsersModule],
  controllers: [ApiTokensController, UserApiTokensController],
  // 빈도 제한의 저장소는 이 모듈의 **provider 하나**다 — 로그인 등 IP별 제한(AuthModule)과 예산이 섞이지 않고, 가드가 몇 개로 만들어지든 예산은 하나다 (T-027)
  providers: [ApiTokensService, ApiTokenGuard, ApiRateLimitGuard, RateLimitStore],
  exports: [ApiTokensService, ApiTokenGuard, ApiRateLimitGuard, RateLimitStore],
})
export class ApiTokensModule {}
