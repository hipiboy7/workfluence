import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { LLM_LIMITS, type LlmAskDto, type LlmStreamStatus, type Principal } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import type { LlmProviderRow } from '../db/schema';
import { LlmConversationsService, type ExchangeInput, type NewConversation } from './conversations.service';
import { dbErrorText } from './db-error';
import { buildChatMessages, conversationTitle } from './domain/conversation';
import type { ChatMessage } from './domain/openai';
import { LLM_CLIENT, LlmError, type LlmClient, type LlmTarget } from './llm.provider';
import { LlmPromptsService } from './prompts.service';
import { LlmProvidersService } from './providers.service';
import type { LlmSink } from './stream.sink';

/** 시간 상한을 사람 말로 — 1분 이상은 분, 그 아래는 초 */
function spell(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}분` : `${Math.round(ms / 1000)}초`;
}

/** 흘려보내기 전에 확인을 마친 질문 하나 (D.1) */
export type PreparedAsk = {
  provider: LlmProviderRow;
  target: LlmTarget;
  messages: ChatMessage[];
  question: string;
  /** 이어 묻는 대화의 id, 새 대화면 제목과 지시문 복사본 */
  conversationId: string | null;
  newConversation: NewConversation | null;
  controller: AbortController;
};

/**
 * 질문 중계 (P10_설계서_Llm D.1·D.2·D.5, FR-1110~1120).
 *
 * **확인은 흘려보내기 전에 한다**(`prepare`) — 입력·LLM·대화·지시문의 주인·동시 질문·키 풀기. 여기서 실패하면 보통의 HTTP 오류다.
 * 통과하면 흐름을 열고(`run`) LLM 쪽 실패는 **흐름 안에서** `end`로 말한다. `run`은 던지지 않는다.
 *
 * 질문과 답은 **로그에 남기지 않는다** (FR-1117). 로그에 가는 것은 종류와 크기뿐이다.
 */
@Injectable()
export class LlmAskService {
  private readonly log = new Logger('Llm');
  /** 한 사람이 **동시에 하나만** 묻는다 (FR-1114, A.1-11). 단일 앱 서버라 메모리 한 곳이면 된다(0.1절) */
  private readonly active = new Map<string, AbortController>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    private readonly audit: AuditService,
    private readonly providers: LlmProvidersService,
    private readonly prompts: LlmPromptsService,
    private readonly conversations: LlmConversationsService,
    @Inject(LLM_CLIENT) private readonly client: LlmClient,
  ) {}

  /**
   * 흘려보내기 전의 확인. 통과하면 **그 사람의 자리를 잡는다** — 부른 쪽은 반드시 `run`을 부른다(`run`이 자리를 푼다).
   */
  async prepare(me: Principal, dto: LlmAskDto): Promise<PreparedAsk> {
    if (this.active.has(me.id)) throw new ConflictException('이미 답을 받고 있다 — 끝나거나 중지한 뒤에 묻는다');
    const { provider, target } = await this.providers.resolve(dto.providerId);

    let messages: ChatMessage[];
    let newConversation: NewConversation | null = null;
    if (dto.conversationId) {
      const { conversation, history } = await this.conversations.loadForAsk(me, dto.conversationId);
      // 질문과 답 둘이 더해진다 (D.3). 넘으면 새 대화로 — **앞에서 몰래 자르지 않는다**
      if (history.length + 2 > LLM_LIMITS.messagesPerConversation) {
        throw new ConflictException(`대화 하나에 메시지는 ${LLM_LIMITS.messagesPerConversation}개까지다 — 새 대화를 시작한다`);
      }
      messages = buildChatMessages(conversation.systemPrompt, history, dto.question);
    } else {
      const prompt = dto.promptId ? await this.prompts.getOwned(me, dto.promptId) : null;
      newConversation = { title: conversationTitle(dto.question), promptName: prompt?.name ?? null, systemPrompt: prompt?.content ?? null };
      messages = buildChatMessages(newConversation.systemPrompt, [], dto.question);
    }

    // 확인하는 사이에 같은 사람의 다른 질문이 자리를 잡았을 수 있다 — 여기서 다시 본다
    if (this.active.has(me.id)) throw new ConflictException('이미 답을 받고 있다 — 끝나거나 중지한 뒤에 묻는다');
    const controller = new AbortController();
    this.active.set(me.id, controller);
    return { provider, target, messages, question: dto.question, conversationId: dto.conversationId ?? null, newConversation, controller };
  }

  /** 내가 받고 있는 답을 멈춘다 (FR-1113). 흐름은 끊지 않는다 — 서버가 저장한 결과를 `end`로 끝까지 받는다 */
  stop(me: Principal): boolean {
    const c = this.active.get(me.id);
    if (!c) return false;
    c.abort();
    return true;
  }

  /** 흘려보낸다. **던지지 않는다** — 모든 결과가 `end` 한 줄이다 */
  async run(me: Principal, p: PreparedAsk, sink: LlmSink, ip: string | null): Promise<void> {
    const started = Date.now();
    const askedAt = new Date();
    const timeout = AbortSignal.timeout(this.env.WF_LLM_TIMEOUT_MS);
    const signal = AbortSignal.any([p.controller.signal, timeout]);
    // 받는 쪽이 끊기면 LLM 요청도 끊는다 — 거기까지는 저장한다
    sink.onGone(() => p.controller.abort());

    let answer = '';
    let thinkingChars = 0;
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    let status: LlmStreamStatus = 'done';
    let message: string | null = null;

    try {
      for await (const chunk of this.client.stream(p.target, p.messages, signal)) {
        if (chunk.kind === 'answer') {
          if (answer.length + chunk.text.length > LLM_LIMITS.answerMaxChars) {
            // 상한까지만 받고 끊는다 (FR-1116) — 거기까지는 답이다
            const room = LLM_LIMITS.answerMaxChars - answer.length;
            answer += chunk.text.slice(0, room);
            if (room > 0) sink.write({ type: 'delta', text: chunk.text.slice(0, room) });
            status = 'failed';
            message = `답이 상한(${LLM_LIMITS.answerMaxChars.toLocaleString('ko-KR')}자)을 넘어 끊었다`;
            break;
          }
          answer += chunk.text;
          sink.write({ type: 'delta', text: chunk.text });
        } else if (chunk.kind === 'thinking') {
          thinkingChars += chunk.text.length;
          if (thinkingChars > LLM_LIMITS.answerMaxChars) {
            status = 'failed';
            message = `생각 과정이 상한(${LLM_LIMITS.answerMaxChars.toLocaleString('ko-KR')}자)을 넘어 끊었다`;
            break;
          }
          sink.write({ type: 'thinking', text: chunk.text });
        } else {
          usage = { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
        }
      }
    } catch (e) {
      if (p.controller.signal.aborted) {
        status = 'stopped';
      } else if (e instanceof LlmError) {
        status = 'failed';
        message = e.kind === 'timeout' ? `시간 상한(${spell(this.env.WF_LLM_TIMEOUT_MS)})을 넘었다` : e.message;
      } else {
        status = 'failed';
        message = 'LLM 응답을 처리하지 못했다';
        // **내용을 싣지 않는다** — 종류만 (FR-1117)
        this.log.error(`LLM 응답을 처리하지 못했다: ${e instanceof Error ? e.name : typeof e}`);
      }
    }
    // 멈추라는 말을 들은 어댑터가 던지지 않고 흐름을 닫을 수도 있다 — 그래도 끝난 것이 아니라 멈춘 것이다
    if (status === 'done' && p.controller.signal.aborted) status = 'stopped';

    const content = answer.trim();
    let saved = false;
    let conversationId = p.conversationId;
    let evicted = 0;
    const detail = (extra: Record<string, unknown>) => ({
      providerId: p.provider.id,
      provider: p.provider.name,
      model: p.provider.model,
      status,
      newConversation: p.conversationId === null,
      questionChars: p.question.length,
      answerChars: content.length,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      durationMs: Date.now() - started,
      ...extra,
    });

    // **답에 글자가 있을 때만 저장한다** (D.5) — 빈 대화가 상한을 먹지 않게. 화면은 질문을 입력칸에 되돌린다
    if (content) {
      try {
        const base = { userId: me.id, providerId: p.provider.id, question: p.question, answer: content, model: p.provider.model, status, askedAt };
        const input: ExchangeInput = p.conversationId
          ? { ...base, conversationId: p.conversationId, newConversation: null }
          : { ...base, conversationId: null, newConversation: p.newConversation as NewConversation };
        const r = await this.db.transaction(async (tx) => {
          const result = await this.conversations.saveExchange(input, tx);
          // 저장과 감사 기록은 한 몸이다 — "물었다고 적혀 있는데 대화가 없는" 상태를 만들지 않는다
          if (result.saved) {
            await this.audit.record(
              { action: 'llm.ask', actorId: me.id, targetType: 'llm.conversation', targetId: result.conversationId, detail: detail({ saved: true, evicted: result.evicted }), ip },
              tx,
            );
          }
          return result;
        });
        saved = r.saved;
        conversationId = r.conversationId;
        evicted = r.evicted;
        if (!saved) message = '그 사이에 대화가 지워져 이 답을 저장하지 않았다';
      } catch (e) {
        message = '답을 저장하지 못했다';
        this.log.error(`LLM 대화를 저장하지 못했다: ${dbErrorText(e)}`);
      }
    }
    if (!saved) {
      // 저장하지 않았어도 **물었다는 사실**은 남긴다 — 업무 내용이 사내 다른 서버로 나갔을 수 있다 (A.1-8)
      await this.audit
        .record({
          action: 'llm.ask',
          actorId: me.id,
          targetType: 'llm.conversation',
          targetId: p.conversationId,
          detail: detail({ saved: false, evicted: 0 }),
          ip,
        })
        .catch((e: unknown) => this.log.error(`LLM 질문의 감사 기록을 남기지 못했다: ${dbErrorText(e)}`));
    }

    try {
      sink.write({ type: 'end', status, saved, conversationId: saved ? conversationId : p.conversationId, evicted, message });
      sink.close();
    } finally {
      // 자리를 푼다 — 그 사이 다른 질문이 잡은 자리면 건드리지 않는다
      if (this.active.get(me.id) === p.controller) this.active.delete(me.id);
    }
  }

  /** `prepare`는 했는데 `run`을 부르지 못했을 때 자리를 푼다 */
  release(me: Principal, p: PreparedAsk): void {
    if (this.active.get(me.id) === p.controller) this.active.delete(me.id);
  }
}
