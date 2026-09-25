import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runInRequestContext } from '../common/request-context';
import { auditEvents } from '../db/schema';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { AuditService } from './audit.service';

/** B등급 — 실제 PostgreSQL. 감사 행이 그 요청의 식별자를 남긴다 (P11_설계서_Ops D.2, FR-1212) */

let db: TestDb;
beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('감사 행의 요청 식별자', () => {
  it('**요청 안에서 남긴 행에는 그 요청의 식별자** — 트랜잭션 안에서도. 요청 밖(정리·자동 저장)이면 비운다', async () => {
    const audit = new AuditService(db);
    await runInRequestContext({ requestId: 'req-audit-0001' }, () => audit.record({ action: 'space.create', targetType: 'space' }));
    await runInRequestContext({ requestId: 'req-audit-0002' }, () =>
      db.transaction(async (tx) => {
        await tx.select().from(auditEvents);
        await audit.record({ action: 'page.create', targetType: 'page' }, tx);
      }),
    );
    await audit.record({ action: 'llm.conversation.purge', targetType: 'system' });
    const rows = await db.select({ action: auditEvents.action, requestId: auditEvents.requestId }).from(auditEvents);
    expect(Object.fromEntries(rows.map((r) => [r.action, r.requestId]))).toEqual({
      'space.create': 'req-audit-0001',
      'page.create': 'req-audit-0002',
      'llm.conversation.purge': null,
    });
  });
});
