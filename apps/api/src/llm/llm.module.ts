import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  LLM_TIMINGS,
  createLlmPromptDto,
  createLlmProviderDto,
  llmAskDto,
  updateLlmPromptDto,
  type CreateLlmPromptDto,
  type CreateLlmProviderDto,
  type LlmAskDto,
  type LlmCheckView,
  type LlmConversationList,
  type LlmConversationView,
  type LlmPromptView,
  type LlmProviderAdminView,
  type LlmProviderView,
  type UpdateLlmPromptDto,
} from '@workfluence/shared';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { LlmAskService } from './ask.service';
import { LlmConversationsService } from './conversations.service';
import { LLM_CLIENT } from './llm.provider';
import { OpenAiCompatClient } from './openai.client';
import { LlmPromptsService } from './prompts.service';
import { LlmProvidersService } from './providers.service';
import { dbErrorText } from './db-error';
import { NdjsonSink } from './stream.sink';

/**
 * 사내 LLM 질문 API (P10_설계서_Llm F절). 가드는 로그인만 본다 — **데이터 범위는 서비스가 좁힌다**(모든 질의에 `user_id = 나`).
 */
@Controller('api/llm')
@UseGuards(AuthGuard)
export class LlmController {
  constructor(
    private readonly providers: LlmProvidersService,
    private readonly prompts: LlmPromptsService,
    private readonly conversations: LlmConversationsService,
    private readonly ask: LlmAskService,
  ) {}

  /** 이름과 모델만 (FR-1107) */
  @Get('providers')
  listProviders(): Promise<LlmProviderView[]> {
    return this.providers.list();
  }

  @Get('prompts')
  listPrompts(@CurrentUser() me: SessionUser): Promise<LlmPromptView[]> {
    return this.prompts.list(me);
  }

  @Post('prompts')
  createPrompt(@Body(new ZodPipe(createLlmPromptDto)) dto: CreateLlmPromptDto, @CurrentUser() me: SessionUser): Promise<LlmPromptView> {
    return this.prompts.create(me, dto);
  }

  @Patch('prompts/:id')
  updatePrompt(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateLlmPromptDto)) dto: UpdateLlmPromptDto,
    @CurrentUser() me: SessionUser,
  ): Promise<LlmPromptView> {
    return this.prompts.update(me, id, dto);
  }

  @Delete('prompts/:id')
  async removePrompt(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<{ ok: true }> {
    await this.prompts.remove(me, id);
    return { ok: true };
  }

  @Get('conversations')
  listConversations(@CurrentUser() me: SessionUser): Promise<LlmConversationList> {
    return this.conversations.list(me);
  }

  @Get('conversations/:id')
  getConversation(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<LlmConversationView> {
    return this.conversations.get(me, id);
  }

  @Delete('conversations/:id')
  async removeConversation(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<{ ok: true }> {
    await this.conversations.remove(me, id);
    return { ok: true };
  }

  @Put('conversations/:id/pin')
  async pin(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<{ ok: true }> {
    await this.conversations.pin(me, id);
    return { ok: true };
  }

  @Delete('conversations/:id/pin')
  async unpin(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<{ ok: true }> {
    await this.conversations.unpin(me, id);
    return { ok: true };
  }

  /**
   * 질문 → NDJSON 흐름 (D.1). **확인은 흘려보내기 전에** 한다 — 거기서 실패하면 보통의 JSON 오류다. 흐름을 연 뒤의 실패는
   * `end` 한 줄로 말한다. 응답은 직접 쓴다(`@Res()`) — Nest가 JSON으로 감싸지 않게.
   */
  @Post('ask')
  async askLlm(@Body(new ZodPipe(llmAskDto)) dto: LlmAskDto, @CurrentUser() me: SessionUser, @Req() req: Request, @Res() res: Response): Promise<void> {
    const prepared = await this.ask.prepare(me, dto);
    let sink: NdjsonSink;
    try {
      sink = new NdjsonSink(res, LLM_TIMINGS.heartbeatMs);
    } catch (e) {
      this.ask.release(me, prepared);
      throw e;
    }
    await this.ask.run(me, prepared, sink, req.ip ?? null);
  }

  /** 내가 받고 있는 답을 멈춘다 (FR-1113). 흐름은 서버가 저장한 결과를 `end`로 끝까지 보낸다 */
  @Post('stop')
  @HttpCode(200)
  stop(@CurrentUser() me: SessionUser): { stopped: boolean } {
    return { stopped: this.ask.stop(me) };
  }
}

/** LLM 등록 관리 (FR-1100~1106). **root만** — `system.manage` (A.1-1) */
@Controller('api/llm/admin/providers')
@UseGuards(AuthGuard)
export class LlmAdminController {
  constructor(
    private readonly providers: LlmProvidersService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  @RequireAction('system.manage')
  list(@CurrentUser() me: SessionUser): Promise<LlmProviderAdminView[]> {
    return this.providers.listAdmin(me);
  }

  @Post()
  @RequireAction('system.manage')
  create(
    @Body(new ZodPipe(createLlmProviderDto)) dto: CreateLlmProviderDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<LlmProviderAdminView> {
    return this.db.transaction(async (tx) => {
      const view = await this.providers.create(dto, me, tx);
      // **키는 싣지 않는다** — 있다는 사실만 (FR-1102·1106)
      await this.audit.record(
        {
          action: 'llm.provider.create',
          actorId: me.id,
          targetType: 'llm.provider',
          targetId: view.id,
          detail: { name: view.name, baseUrl: view.baseUrl, model: view.model, hasKey: view.hasKey },
          ip: req.ip,
        },
        tx,
      );
      return view;
    });
  }

  @Delete(':id')
  @RequireAction('system.manage')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      const gone = await this.providers.remove(id, me, tx);
      await this.audit.record({ action: 'llm.provider.delete', actorId: me.id, targetType: 'llm.provider', targetId: id, detail: gone, ip: req.ip }, tx);
    });
    return { ok: true };
  }

  /** 연결 확인 (FR-1105). 바꾸는 것이 없어 감사로그에 남기지 않는다 — 다른 조회와 같다 */
  @Post(':id/check')
  @HttpCode(200)
  @RequireAction('system.manage')
  check(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<LlmCheckView> {
    return this.providers.check(id, me);
  }
}

/**
 * 만료된 대화를 **앱이 스스로** 지운다 (FR-1136, A.1-7). 기동할 때 한 번, 그 뒤 `LLM_TIMINGS.sweepMs`마다.
 * 실패는 로그에 남기고 다음 주기에 다시 한다 — 정리가 실패했다고 앱을 멈추지 않는다.
 */
@Injectable()
export class LlmSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Llm');
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly conversations: LlmConversationsService,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.WF_ENV === 'test') return;
    const run = () =>
      void this.conversations
        .sweepExpired()
        .then((n) => {
          if (n) this.log.log(`보존 기간이 지난 LLM 대화 ${n}개를 지웠다`);
        })
        .catch((e: unknown) => this.log.error(`만료된 LLM 대화를 지우지 못했다: ${dbErrorText(e)}`));
    run();
    this.timer = setInterval(run, LLM_TIMINGS.sweepMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}

/**
 * LLM 배선 (P10_설계서_Llm H절). 어댑터는 `LLM_CLIENT` 토큰 뒤에 있다 — 메일(`MAIL_SENDER`)과 같은 모양이다(2절 DIP).
 */
@Module({
  providers: [
    { provide: LLM_CLIENT, useClass: OpenAiCompatClient },
    LlmProvidersService,
    LlmPromptsService,
    LlmConversationsService,
    LlmAskService,
    LlmSweeper,
  ],
  controllers: [LlmController, LlmAdminController],
})
export class LlmModule {}
