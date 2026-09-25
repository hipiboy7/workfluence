import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { LlmConversationList, LlmConversationSummary, LlmConversationView, LlmStreamStatus, Principal } from '@workfluence/shared';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { DB, type Db } from '../db/db.module';
import { llmConversations, llmMessages, llmProviders, type LlmConversationRow } from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { canPin, expiresAt, retentionCutoff, type HistoryMessage } from './domain/conversation';

/**
 * 대화 보관 (P10_설계서_Llm C.4·D.5, FR-1130~1139).
 *
 * 규칙은 세 시각이다 — `updated_at`(목록 순서), `retain_from`(보존 기간의 기준: 질문하면·고정을 풀면 지금), `pinned_at`(고정).
 * **만료** = 고정하지 않았고 `retain_from`이 N일 전보다 앞선 것. 목록·열기·이어 묻기가 모두 이 조건으로 거른다(FR-1137) —
 * 정리가 돌기 전이라도 만료된 것은 없는 것과 같다.
 *
 * 모든 질의가 `user_id = 나`로 좁힌다. 남의 대화는 없는 것과 같이 404다 — **관리자도**(FR-1139).
 */

/** 새 대화의 제목과 시작할 때의 지시문 복사본 (FR-1127) */
export type NewConversation = { title: string; promptName: string | null; systemPrompt: string | null };

/** 새 질문과 답 한 쌍을 남기는 데 필요한 것. 이어 묻는 대화이거나(`conversationId`) 새 대화다(`newConversation`) */
export type ExchangeInput = (
  | { conversationId: string; newConversation: null }
  | { conversationId: null; newConversation: NewConversation }
) & {
  userId: string;
  providerId: string;
  question: string;
  /** 생각 과정을 뺀 답 (FR-1119) */
  answer: string;
  model: string;
  status: LlmStreamStatus;
  askedAt: Date;
};

export type ExchangeResult = { saved: boolean; conversationId: string | null; evicted: number };

@Injectable()
export class LlmConversationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** 보이는 것 — 고정했거나, 보존 기간 안이다 */
  private visible(cutoff: Date): SQL {
    return or(isNotNull(llmConversations.pinnedAt), gte(llmConversations.retainFrom, cutoff)) as SQL;
  }

  /**
   * 지금의 상한. **트랜잭션 안에서는 그 트랜잭션으로 읽는다** — 풀에서 연결을 하나 더 잡으면 풀이 마를 때 서로를 기다린다(T-026의 모양,
   * 검토 반영)
   */
  private async limits(tx?: Db): Promise<{ retentionDays: number; conversationMax: number; pinnedMax: number; cutoff: Date }> {
    const p = await this.settings.get(tx);
    return {
      retentionDays: p.llmRetentionDays,
      conversationMax: p.llmConversationMax,
      pinnedMax: p.llmPinnedMax,
      cutoff: retentionCutoff(new Date(), p.llmRetentionDays),
    };
  }

  /** 그 사람의 대화 줄을 세운다 — 세고 지우는 사이에 같은 사람의 다른 저장이 끼지 않게 (D.5) */
  private async lockUser(tx: Db, userId: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`llm:${userId}`}))`);
  }

  private summaryOf(r: LlmConversationRow & { providerName: string | null }, retentionDays: number): LlmConversationSummary {
    return {
      id: r.id,
      title: r.title,
      providerId: r.providerId,
      providerName: r.providerName,
      promptName: r.promptName,
      pinned: r.pinnedAt !== null,
      updatedAt: r.updatedAt.toISOString(),
      expiresAt: r.pinnedAt ? null : expiresAt(r.retainFrom, retentionDays).toISOString(),
    };
  }

  /** 내 대화(만료 제외) + 내가 지켜야 할 상한 (G절) */
  async list(me: Principal): Promise<LlmConversationList> {
    const l = await this.limits();
    const rows = await this.db
      .select({ c: llmConversations, providerName: llmProviders.name })
      .from(llmConversations)
      .leftJoin(llmProviders, eq(llmProviders.id, llmConversations.providerId))
      .where(and(eq(llmConversations.userId, me.id), this.visible(l.cutoff)))
      .orderBy(desc(llmConversations.updatedAt));
    return {
      items: rows.map((r) => this.summaryOf({ ...r.c, providerName: r.providerName }, l.retentionDays)),
      limits: { retentionDays: l.retentionDays, conversationMax: l.conversationMax, pinnedMax: l.pinnedMax },
    };
  }

  private async findVisible(me: Principal, id: string, cutoff: Date, tx: Db = this.db): Promise<LlmConversationRow> {
    const row = await tx.query.llmConversations.findFirst({
      where: and(eq(llmConversations.id, id), eq(llmConversations.userId, me.id), this.visible(cutoff)),
    });
    if (!row) throw new NotFoundException('대화를 찾을 수 없다 — 지웠거나 보존 기간이 지났다');
    return row;
  }

  /** 대화와 메시지. 차례는 `seq`다 */
  async get(me: Principal, id: string): Promise<LlmConversationView> {
    const l = await this.limits();
    const row = await this.findVisible(me, id, l.cutoff);
    const provider = row.providerId
      ? await this.db.query.llmProviders.findFirst({ where: eq(llmProviders.id, row.providerId), columns: { name: true } })
      : undefined;
    const messages = await this.db.select().from(llmMessages).where(eq(llmMessages.conversationId, id)).orderBy(asc(llmMessages.seq));
    return {
      ...this.summaryOf({ ...row, providerName: provider?.name ?? null }, l.retentionDays),
      systemPrompt: row.systemPrompt,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        model: m.model,
        status: m.status as LlmStreamStatus,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /** 이어 묻기 전에 — 그 대화의 지시문 복사본과 이력, 메시지 수 (D.2·D.3) */
  async loadForAsk(me: Principal, id: string): Promise<{ conversation: LlmConversationRow; history: HistoryMessage[] }> {
    const l = await this.limits();
    const conversation = await this.findVisible(me, id, l.cutoff);
    const rows = await this.db
      .select({ role: llmMessages.role, content: llmMessages.content })
      .from(llmMessages)
      .where(eq(llmMessages.conversationId, id))
      .orderBy(asc(llmMessages.seq));
    return { conversation, history: rows.map((r) => ({ role: r.role as HistoryMessage['role'], content: r.content })) };
  }

  /** 지운다 (FR-1138). 되살리기는 없다 — 메시지도 함께 지워진다 */
  async remove(me: Principal, id: string): Promise<void> {
    const l = await this.limits();
    const rows = await this.db
      .delete(llmConversations)
      .where(and(eq(llmConversations.id, id), eq(llmConversations.userId, me.id), this.visible(l.cutoff)))
      .returning({ id: llmConversations.id });
    if (!rows.length) throw new NotFoundException('대화를 찾을 수 없다 — 지웠거나 보존 기간이 지났다');
  }

  /**
   * 고정 (FR-1133). K개가 차면 409. 이미 고정한 것은 그대로 둔다.
   * **상한을 지금 고정 수보다 낮춘 경우에도** 새 고정만 막는다 — 있던 고정은 풀지 않는다 (D.5).
   */
  async pin(me: Principal, id: string): Promise<void> {
    const l = await this.limits();
    await this.db.transaction(async (tx) => {
      await this.lockUser(tx, me.id);
      const row = await this.findVisible(me, id, l.cutoff, tx);
      if (row.pinnedAt) return;
      const [{ n }] = await tx
        .select({ n: count() })
        .from(llmConversations)
        .where(and(eq(llmConversations.userId, me.id), isNotNull(llmConversations.pinnedAt)));
      if (!canPin(n, l.pinnedMax)) throw new ConflictException(`고정은 ${l.pinnedMax}개까지다 — 하나를 풀고 고정한다`);
      await tx.update(llmConversations).set({ pinnedAt: new Date() }).where(eq(llmConversations.id, id));
    });
  }

  /** 고정을 푼다 (FR-1135). **그때부터** 보존 기간을 센다 — 풀자마자 지워지지 않게 (A.1-5). 고정하지 않은 것이면 그대로 */
  async unpin(me: Principal, id: string): Promise<void> {
    const l = await this.limits();
    const row = await this.findVisible(me, id, l.cutoff);
    if (!row.pinnedAt) return;
    await this.db
      .update(llmConversations)
      .set({ pinnedAt: null, retainFrom: new Date() })
      .where(and(eq(llmConversations.id, id), eq(llmConversations.userId, me.id)));
  }

  /**
   * 질문과 답 한 쌍을 남긴다 (D.5). **호출부의 트랜잭션 안에서** — 감사 기록(`llm.ask`)과 한 몸이다.
   *
   * 1. 그 사람의 잠금 2. 대화 만들기·고치기(이어 묻는 사이에 지워졌으면 저장하지 않는다) 3. 질문·답을 한 문장으로(차례 = `seq`)
   * 4. 그 사람의 만료된 것을 지우고 5. M개를 넘는 만큼 **고정하지 않은 것 중 `retain_from`이 가장 오래된 것부터** 지운다.
   *
   * - **이어 묻는 대화가 답을 받는 사이 만료됐어도 살린다** — 물을 때 보였던 대화다. 기준을 지금으로 고치므로 4에서 지워지지 않는다.
   *   정리가 이미 지웠으면(행이 없다) 저장하지 않는다 (검토 반영)
   * - **답을 받는 사이 LLM이 지워졌으면 LLM 칸을 비운다** — 그대로 넣으면 FK 위반으로 답이 통째로 사라진다(FR-1101, 검토 반영 — 셋 다 짚었다)
   * - 관리자가 M을 **지금 고정 수보다** 낮추면 고정은 지우지 않으므로 M을 넘은 채로 남는다(사람이 한 고정을 관리 작업이 되돌리지 않는다).
   *   그때도 새 대화는 저장되고, 고정하지 않은 앞 대화가 지워진다
   */
  async saveExchange(x: ExchangeInput, tx: Db): Promise<ExchangeResult> {
    await this.lockUser(tx, x.userId);
    const l = await this.limits(tx);
    const now = new Date();
    // 지워진 LLM이면 NULL — 저장하는 문장이 도는 그 순간의 행을 본다
    const providerId = sql<string | null>`(SELECT id FROM llm_providers WHERE id = ${x.providerId})`;
    let id: string;
    if (x.conversationId !== null) {
      const [row] = await tx
        .update(llmConversations)
        .set({ updatedAt: now, retainFrom: now, providerId })
        .where(and(eq(llmConversations.id, x.conversationId), eq(llmConversations.userId, x.userId)))
        .returning({ id: llmConversations.id });
      if (!row) return { saved: false, conversationId: x.conversationId, evicted: 0 };
      id = row.id;
    } else {
      const n = x.newConversation;
      const [row] = await tx
        .insert(llmConversations)
        .values({
          userId: x.userId,
          title: n.title,
          providerId,
          promptName: n.promptName,
          systemPrompt: n.systemPrompt,
          retainFrom: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: llmConversations.id });
      id = row.id;
    }
    await tx.insert(llmMessages).values([
      { conversationId: id, role: 'user', content: x.question, status: 'done', createdAt: x.askedAt },
      { conversationId: id, role: 'assistant', content: x.answer, model: x.model, status: x.status, createdAt: now },
    ]);

    // 정리가 돌기 전이라도 이 사람의 만료된 것은 세지 않는다 — 지운다
    await tx
      .delete(llmConversations)
      .where(and(eq(llmConversations.userId, x.userId), isNull(llmConversations.pinnedAt), lt(llmConversations.retainFrom, l.cutoff)));
    const [{ total }] = await tx.select({ total: count() }).from(llmConversations).where(eq(llmConversations.userId, x.userId));
    const excess = total - l.conversationMax;
    let evicted = 0;
    if (excess > 0) {
      const victims = await tx
        .select({ id: llmConversations.id })
        .from(llmConversations)
        .where(and(eq(llmConversations.userId, x.userId), isNull(llmConversations.pinnedAt), ne(llmConversations.id, id)))
        .orderBy(asc(llmConversations.retainFrom))
        .limit(excess);
      if (victims.length) {
        await tx.delete(llmConversations).where(
          inArray(
            llmConversations.id,
            victims.map((v) => v.id),
          ),
        );
      }
      evicted = victims.length;
    }
    return { saved: true, conversationId: id, evicted };
  }

  /**
   * 만료된 대화를 지운다 (FR-1136) — 앱이 한 시간마다 부른다(A.1-7). 지운 수를 감사로그에 남긴다. 지운 것이 없으면 남기지 않는다 —
   * 한 시간마다 "0건"이 쌓이면 감사로그가 소음이 된다.
   */
  async sweepExpired(): Promise<number> {
    const l = await this.limits();
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(llmConversations)
        .where(and(isNull(llmConversations.pinnedAt), lt(llmConversations.retainFrom, l.cutoff)))
        .returning({ id: llmConversations.id });
      if (rows.length) {
        await this.audit.record(
          { action: 'llm.conversation.purge', targetType: 'system', detail: { deleted: rows.length, retentionDays: l.retentionDays } },
          tx,
        );
      }
      return rows.length;
    });
  }
}
