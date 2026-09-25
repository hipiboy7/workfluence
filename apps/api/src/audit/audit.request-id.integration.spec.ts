import { auditQueryDto } from '@workfluence/shared';
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

  it('**요청 번호로 거른다** — 관리 화면의 감사로그가 로그 한 줄에서 그 요청의 행으로 간다. 목록에 번호가 보인다 (FR-1212, 코드 리뷰 10)', async () => {
    const audit = new AuditService(db);
    await runInRequestContext({ requestId: 'c4f74de7a73ff592ec5ec63e597de58b' }, () => audit.record({ action: 'space.create', targetType: 'space' }));
    await runInRequestContext({ requestId: 'req-audit-other' }, () => audit.record({ action: 'page.create', targetType: 'page' }));
    await audit.record({ action: 'llm.conversation.purge', targetType: 'system' });

    const hit = await audit.list(auditQueryDto.parse({ requestId: 'c4f74de7a73ff592ec5ec63e597de58b' }));
    expect(hit.map((r) => [r.action, r.requestId])).toEqual([['space.create', 'c4f74de7a73ff592ec5ec63e597de58b']]);
    const all = await audit.list(auditQueryDto.parse({}));
    expect(all.map((r) => r.requestId).sort()).toEqual(['c4f74de7a73ff592ec5ec63e597de58b', 'req-audit-other', null].sort());
  });
});
