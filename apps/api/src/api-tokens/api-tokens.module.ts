import { Body, Controller, Delete, Get, Module, Param, Post, Req, UseGuards } from '@nestjs/common';
import { API_TOKEN_LIMITS, API_TOKEN_SCOPES, createApiTokenDto, type ApiTokenView, type CreateApiTokenDto } from '@workfluence/shared';
import type { Request } from 'express';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { UsersModule } from '../users/users.module';
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

/** 공개 API 토큰 (docs/spinoff/public-api 계획서 4.1절) */
@Module({
  imports: [UsersModule],
  controllers: [ApiTokensController],
  providers: [ApiTokensService, ApiTokenGuard],
  exports: [ApiTokensService, ApiTokenGuard],
})
export class ApiTokensModule {}
