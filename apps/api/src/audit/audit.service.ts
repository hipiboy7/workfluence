import { Inject, Injectable } from '@nestjs/common';
import { maskEmail, type AuditAction, type AuditEventView, type AuditQueryDto } from '@workfluence/shared';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { currentRequest } from '../common/request-context';
import { DB, type Db } from '../db/db.module';
import { auditEvents, users } from '../db/schema';

/**
 * 감사로그 (P1_설계서_Auth 6절, FR-235~239).
 *
 * 남기지 않는 것 (FR-238): 비밀번호·임시 비밀번호·토큰·세션 ID. email은 마스킹해서 넣는다.
 * 감사로그는 사고가 났을 때 오래 들여다보는 자료라, 거기에 비밀이 있으면 그 자체가 사고가 된다.
 */
export type AuditInput = {
  action: AuditAction;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
};

/**
 * detail에 실어도 되는 값으로 줄인다. email은 마스킹하고, 비밀 계열 키는 통째로 버린다.
 *
 * 패턴은 **넓게** 잡는다. 좁게 잡으면 새는 쪽으로 틀리고, 넓게 잡으면 기록이 조금 부실해질 뿐이다.
 * (`sid`만 넣었다가 `sessionId`가 통과한 적이 있다 — 테스트가 잡았다.)
 * `api_key`·`apiKey`는 P10에서 더했다 — LLM API 키를 실수로 실어도 떨어지게 (P10_설계서_Llm D.4)
 *
 * **넓은 패턴의 값: 비밀이 아닌 값도 이름만 맞으면 조용히 버린다.** 맨 윗단의 키만 보므로, 이 낱말이 든 이름의 평범한 값
 * (토큰 수 등)은 한 겹 아래에 둔다 — `llm.ask`의 `usage: { prompt, completion }`처럼 (T-043)
 */
const SECRET_KEYS = /pass|secret|token|hash|session|sid|cookie|authorization|credential|api_?key/i;

export function sanitizeDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_KEYS.test(k)) continue;
    out[k] = k.toLowerCase().includes('email') && typeof v === 'string' ? maskEmail(v) : v;
  }
  return out;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 기록. **본 작업과 같은 트랜잭션을 받는다** (FR-236).
   * 작업이 롤백되면 기록도 롤백돼야 한다 — "했다고 적혀 있는데 실제로는 안 된" 상태를 만들지 않는다.
   */
  async record(input: AuditInput, tx: Db = this.db): Promise<void> {
    await tx.insert(auditEvents).values({
      action: input.action,
      actorId: input.actorId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      detail: sanitizeDetail(input.detail),
      ip: input.ip ?? null,
      // 그 요청의 식별자 — 앱 로그·nginx 로그와 잇는다. 요청 밖(정리·실시간 편집의 자동 저장)이면 비운다 (P11 FR-1212)
      requestId: currentRequest()?.requestId ?? null,
    });
  }

  /**
   * 조회 (FR-531). 조건은 **질의에서** 건다 — 가져와서 거르면 `limit`이 조용히 빈다.
   * 감사로그는 append-only라 행 수가 계속 늘고, 그 실수의 대가가 가장 큰 곳이다.
   */
  async list(q: AuditQueryDto): Promise<AuditEventView[]> {
    const { limit } = q;
    const conds = [
      q.action ? eq(auditEvents.action, q.action) : undefined,
      q.actorId ? eq(auditEvents.actorId, q.actorId) : undefined,
      q.from ? gte(auditEvents.createdAt, q.from) : undefined,
      q.to ? lt(auditEvents.createdAt, q.to) : undefined,
    ].filter((c) => c !== undefined);

    const rows = await this.db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        actorId: auditEvents.actorId,
        actorName: users.displayName,
        targetType: auditEvents.targetType,
        targetId: auditEvents.targetId,
        detail: auditEvents.detail,
        ip: auditEvents.ip,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      ...r,
      detail: (r.detail as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
