import { ConflictException, Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { LLM_LIMITS, type LlmAskDto, type LlmStreamStatus, type Principal } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import { errorText } from '../common/error-text';
import { RevocationBus } from '../common/revocation.bus';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import type { LlmProviderRow } from '../db/schema';
import { LlmConversationsService, type ExchangeInput, type NewConversation } from './conversations.service';
import { buildChatMessages, conversationTitle } from './domain/conversation';
import type { ChatMessage } from './domain/openai';
import { LLM_CLIENT, LlmError, type LlmClient, type LlmTarget } from './llm.provider';
import { LlmPromptsService } from './prompts.service';
import { LlmProvidersService } from './providers.service';
import type { LlmSink } from './stream.sink';

/** 시간 상한을 사람 말로 — 1분 이상은 분, 그 아래는 초 */
export function spell(ms: number): string {
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
 * 받고 있는 답 하나의 자리 — 누가(세션까지) 쥐었고, 세션이 끊겨 멈췄는가, **아직 흘러오는 중인가**(끝나 저장하는 중이면 멈출 것이 없다)
 */
type ActiveAsk = { controller: AbortController; sid: string | null; revoked: boolean; streaming: boolean };

/**
 * 감사 detail에 적는 실패의 종류 — **남의 문장은 싣지 않는다**(로그·감사에는 종류와 HTTP 상태만). 화면에는 문장이 간다
 */
type Failure = 'unreachable' | 'rejected' | 'protocol' | 'timeout' | 'aborted' | 'revoked' | 'answer-cap' | 'thinking-cap' | 'length' | 'unknown';

/**
 * 질문 중계 (P10_설계서_Llm D.1·D.2·D.5, FR-1110~1120).
 *
 * **확인은 흘려보내기 전에 한다**(`prepare`) — 입력·LLM·대화·지시문의 주인·동시 질문·키 풀기. 여기서 실패하면 보통의 HTTP 오류다.
 * 통과하면 흐름을 열고(`run`) LLM 쪽 실패는 **흐름 안에서** `end`로 말한다. `run`은 던지지 않는다.
 *
 * 질문과 답은 **로그에 남기지 않는다** (FR-1117). 로그에 가는 것은 종류와 크기뿐이다.
 *
 * **세션을 끊으면 흐름도 끊긴다** (FR-1121, 검토 반영 — 코드 리뷰 8). 비밀번호 변경·관리자 강제 종료·로그아웃은 세션 파기 버스를
 * 울리고(`RevocationBus`), 여기서 그 사람(로그아웃이면 그 세션)의 답을 멈춘다 — 실시간 편집(P7 FR-805)과 같은 자리다.
 */
@Injectable()
export class LlmAskService implements OnModuleDestroy {
  private readonly log = new Logger('Llm');
  /** 한 사람이 **동시에 하나만** 묻는다 (FR-1114, A.1-11). 단일 앱 서버라 메모리 한 곳이면 된다(0.1절) */
  private readonly active = new Map<string, ActiveAsk>();
  private readonly unsubscribe: () => void;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    private readonly audit: AuditService,
    private readonly providers: LlmProvidersService,
    private readonly prompts: LlmPromptsService,
    private readonly conversations: LlmConversationsService,
    @Inject(LLM_CLIENT) private readonly client: LlmClient,
    revocation: RevocationBus,
  ) {
    this.unsubscribe = revocation.onRevoke((userId, sid) => this.revoke(userId, sid));
  }

  onModuleDestroy(): void {
    this.unsubscribe();
  }

  /** 세션이 끊겼다 — `sid`가 있으면 그 세션이 연 답만, 없으면 그 사람의 답을 멈춘다 */
  private revoke(userId: string, sid?: string): void {
    const a = this.active.get(userId);
    if (!a || (sid !== undefined && a.sid !== sid)) return;
    a.revoked = true;
    a.controller.abort();
  }

  /**
   * 흘려보내기 전의 확인. 통과하면 **그 사람의 자리를 잡는다** — 부른 쪽은 반드시 `run`을 부른다(`run`이 자리를 푼다).
   */
  async prepare(me: Principal, dto: LlmAskDto, sid: string | null = null): Promise<PreparedAsk> {
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
    this.active.set(me.id, { controller, sid, revoked: false, streaming: true });
    return { provider, target, messages, question: dto.question, conversationId: dto.conversationId ?? null, newConversation, controller };
  }

  /**
   * 내가 받고 있는 답을 멈춘다 (FR-1113). 흐름은 끊지 않는다 — 서버가 저장한 결과를 `end`로 끝까지 받는다.
   * **답이 이미 끝나 저장하는 중이면 멈춘 것이 없다**고 답한다 — 화면은 그 답을 보고 중지 단추를 되살린다 (검토 반영 — 자체 점검 10)
   */
  stop(me: Principal): boolean {
    const a = this.active.get(me.id);
    if (!a?.streaming) return false;
    a.controller.abort();
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
    let failure: Failure | null = null;
    let httpStatus: number | null = null;
    let truncated = false;
    const revoked = () => this.active.get(me.id)?.controller === p.controller && this.active.get(me.id)?.revoked === true;
    const capText = LLM_LIMITS.answerMaxChars.toLocaleString('ko-KR');

    try {
      for await (const chunk of this.client.stream(p.target, p.messages, signal)) {
        if (chunk.kind === 'answer') {
          if (answer.length + chunk.text.length > LLM_LIMITS.answerMaxChars) {
            // 상한까지만 받고 끊는다 (FR-1116) — 거기까지는 답이다
            const room = LLM_LIMITS.answerMaxChars - answer.length;
            answer += chunk.text.slice(0, room);
            if (room > 0) sink.write({ type: 'delta', text: chunk.text.slice(0, room) });
            status = 'failed';
            failure = 'answer-cap';
            message = `답이 상한(${capText}자)을 넘어 끊었다`;
            break;
          }
          answer += chunk.text;
          sink.write({ type: 'delta', text: chunk.text });
        } else if (chunk.kind === 'thinking' || chunk.kind === 'rethink') {
          // `rethink` — 지금까지 흘려보낸 답이 생각 과정이었다. 답에서 빼고 생각 과정으로 센다 (FR-1119)
          const text = chunk.kind === 'thinking' ? chunk.text : answer;
          if (chunk.kind === 'rethink') answer = '';
          thinkingChars += text.length;
          if (thinkingChars > LLM_LIMITS.answerMaxChars) {
            status = 'failed';
            failure = 'thinking-cap';
            message = `생각 과정이 상한(${capText}자)을 넘어 끊었다`;
            break;
          }
          sink.write(chunk.kind === 'thinking' ? { type: 'thinking', text } : { type: 'rethink' });
        } else if (chunk.kind === 'finish') {
          // 모델의 길이 상한에서 잘린 답 — 몰래 끝난 것으로 치지 않는다 (FR-1120, 검토 반영 — 코드 리뷰 4)
          if (chunk.reason === 'length') truncated = true;
        } else {
          usage = { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
        }
      }
    } catch (e) {
      if (p.controller.signal.aborted) {
        status = 'stopped';
        failure = revoked() ? 'revoked' : 'aborted';
      } else if (e instanceof LlmError) {
        status = 'failed';
        failure = e.kind;
        httpStatus = e.status;
        // 우리 전체 상한이 걸렸으면 그렇게 말한다. 어댑터가 말한 시간 제한(조각 사이 무응답 등)은 그 문장대로
        message = e.kind === 'timeout' && timeout.aborted ? `시간 상한(${spell(this.env.WF_LLM_TIMEOUT_MS)})을 넘었다` : e.message;
        // **로그에는 종류와 HTTP 상태만** — 거절 문장은 남의 응답이다 (D.2). 그래도 운영자가 까닭의 종류를 로그에서 본다
        this.log.warn(`LLM 답을 받지 못했다: ${e.kind}${e.status !== null ? ` HTTP ${e.status}` : ''} (provider=${p.provider.id})`);
      } else {
        status = 'failed';
        failure = 'unknown';
        message = 'LLM 응답을 처리하지 못했다';
        // **내용을 싣지 않는다** — `errorText`는 drizzle 문장(매개변수)을 버린다 (FR-1117)
        this.log.error(`LLM 응답을 처리하지 못했다: ${errorText(e)}`);
      }
    }
    // 흐름이 끝났다 — 여기부터의 중지는 멈출 것이 없다
    const slot = this.active.get(me.id);
    if (slot?.controller === p.controller) slot.streaming = false;
    // 멈추라는 말을 들은 어댑터가 던지지 않고 흐름을 닫을 수도 있다 — 그래도 끝난 것이 아니라 멈춘 것이다
    if (status === 'done' && p.controller.signal.aborted) {
      status = 'stopped';
      failure = revoked() ? 'revoked' : 'aborted';
    }
    if (failure === 'revoked') message = '세션이 끝나 답을 멈췄다 — 다시 로그인한다';
    if (status === 'done' && truncated) {
      status = 'failed';
      failure = 'length';
      message = '답이 모델의 길이 상한에서 잘렸다 — 대화가 길면 새 대화를 시작한다';
    }

    // **U+0000은 PostgreSQL text가 받지 않는다** — 모델이 내도 저장이 통째로 실패하지 않게 뺀다 (검토 반영 — 코드 리뷰 10)
    const content = answer.replaceAll('\u0000', '').trim();
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
      // **토큰 수는 `usage` 아래에** — 이름에 `token`이 들어가면 감사 비밀 거르기(`SECRET_KEYS`)가 통째로 버린다(검토 반영 — 셋 다 짚었다)
      usage: usage ? { prompt: usage.promptTokens, completion: usage.completionTokens } : null,
      failure,
      httpStatus,
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
        this.log.error(`LLM 대화를 저장하지 못했다: ${errorText(e)}`);
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
        .catch((e: unknown) => this.log.error(`LLM 질문의 감사 기록을 남기지 못했다: ${errorText(e)}`));
    }

    try {
      sink.write({ type: 'end', status, saved, conversationId: saved ? conversationId : p.conversationId, evicted, message });
      sink.close();
    } finally {
      // 자리를 푼다 — 그 사이 다른 질문이 잡은 자리면 건드리지 않는다
      this.release(me, p);
    }
  }

  /** `prepare`는 했는데 `run`을 부르지 못했을 때 자리를 푼다 */
  release(me: Principal, p: PreparedAsk): void {
    if (this.active.get(me.id)?.controller === p.controller) this.active.delete(me.id);
  }
}
