import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { LLM_LIMITS, type CreateLlmPromptDto, type LlmPromptView, type Principal, type UpdateLlmPromptDto } from '@workfluence/shared';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { llmPrompts, type LlmPromptRow } from '../db/schema';

/**
 * 사람마다의 지시문 — 시스템 프롬프트 (P10_설계서_Llm C.3, FR-1125~1129).
 *
 * **고치거나 지울 때까지 남는다** — 보존 기간이 없다(쟁점 4의 답). 모든 질의가 `user_id = 나`로 좁힌다 — 남의 것은 없는 것과
 * 같이 404다(FR-1128).
 */
const toView = (r: LlmPromptRow): LlmPromptView => ({ id: r.id, name: r.name, content: r.content, updatedAt: r.updatedAt.toISOString() });

@Injectable()
export class LlmPromptsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(me: Principal): Promise<LlmPromptView[]> {
    const rows = await this.db.select().from(llmPrompts).where(eq(llmPrompts.userId, me.id)).orderBy(asc(llmPrompts.name));
    return rows.map(toView);
  }

  /** 내 것 하나. 남의 것이면 없는 것과 같다 */
  async getOwned(me: Principal, id: string, tx: Db = this.db): Promise<LlmPromptRow> {
    const row = await tx.query.llmPrompts.findFirst({ where: and(eq(llmPrompts.id, id), eq(llmPrompts.userId, me.id)) });
    if (!row) throw new NotFoundException('지시문을 찾을 수 없다');
    return row;
  }

  /**
   * 만든다. **사람마다 상한**(`LLM_LIMITS.promptsPerUser`)을 넘으면 409, 이름이 겹치면 409.
   * 세기와 넣기 사이에 같은 사람의 다른 요청이 끼지 않게 그 사람의 잠금을 건다.
   */
  async create(me: Principal, dto: CreateLlmPromptDto): Promise<LlmPromptView> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`llm-prompts:${me.id}`}))`);
      const [{ n }] = await tx.select({ n: count() }).from(llmPrompts).where(eq(llmPrompts.userId, me.id));
      if (n >= LLM_LIMITS.promptsPerUser) throw new ConflictException(`지시문은 ${LLM_LIMITS.promptsPerUser}개까지 저장한다 — 쓰지 않는 것을 지운 뒤 만든다`);
      const [row] = await tx
        .insert(llmPrompts)
        .values({ userId: me.id, name: dto.name, content: dto.content })
        .onConflictDoNothing({ target: [llmPrompts.userId, llmPrompts.name] })
        .returning();
      if (!row) throw new ConflictException('같은 이름의 지시문이 이미 있다');
      return toView(row);
    });
  }

  /** 고친다. 이름을 바꾸면 **내 다른 지시문과 겹치는지** 같은 잠금 안에서 본다 — 겹치면 409 (유일 제약이 마지막 방벽이다) */
  async update(me: Principal, id: string, dto: UpdateLlmPromptDto): Promise<LlmPromptView> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`llm-prompts:${me.id}`}))`);
      await this.getOwned(me, id, tx);
      if (dto.name !== undefined) {
        const clash = await tx.query.llmPrompts.findFirst({
          where: and(eq(llmPrompts.userId, me.id), eq(llmPrompts.name, dto.name), ne(llmPrompts.id, id)),
          columns: { id: true },
        });
        if (clash) throw new ConflictException('같은 이름의 지시문이 이미 있다');
      }
      const [row] = await tx
        .update(llmPrompts)
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.content !== undefined ? { content: dto.content } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(llmPrompts.id, id), eq(llmPrompts.userId, me.id)))
        .returning();
      return toView(row);
    });
  }

  /** 지운다. 그 지시문으로 시작한 대화는 복사본을 들고 있어 그대로다 (FR-1127) */
  async remove(me: Principal, id: string): Promise<void> {
    const rows = await this.db
      .delete(llmPrompts)
      .where(and(eq(llmPrompts.id, id), eq(llmPrompts.userId, me.id)))
      .returning({ id: llmPrompts.id });
    if (!rows.length) throw new NotFoundException('지시문을 찾을 수 없다');
  }
}
