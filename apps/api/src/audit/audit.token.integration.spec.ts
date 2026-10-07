import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runInRequestContext, setRequestToken } from '../common/request-context';
import { auditEvents } from '../db/schema';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { AuditService } from './audit.service';

/** B등급 — 실제 PostgreSQL. 토큰으로 한 일은 감사 행에 그 토큰의 번호가 남는다 (docs/spinoff/public-api 설계서 FR-2212). 키는 `jti`다 — `tokenId`는 감사의 비밀 키 거름(`SECRET_KEYS`)이 지운다 */

let db: TestDb;
beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

const TOKEN = '3b1c8f06-6f0e-4b52-9f63-0c9b2a8c7d11';

describe('감사 행의 토큰 번호', () => {
  it('**토큰으로 부른 요청 안의 행에는 `detail.jti`(토큰 번호)가 붙는다** — 부르는 쪽이 따로 넘기지 않아도, 트랜잭션 안에서도', async () => {
    const audit = new AuditService(db);
    await runInRequestContext({ requestId: 'req-1' }, async () => {
      setRequestToken(TOKEN);
      await audit.record({ action: 'space.create', targetType: 'space', detail: { name: '팀' } });
      await db.transaction((tx) => audit.record({ action: 'page.create', targetType: 'page' }, tx));
    });
    const rows = await db.select({ action: auditEvents.action, detail: auditEvents.detail }).from(auditEvents);
    expect(Object.fromEntries(rows.map((r) => [r.action, r.detail]))).toEqual({
      'space.create': { name: '팀', jti: TOKEN },
      'page.create': { jti: TOKEN },
    });
  });

  it('화면(세션)으로 한 일과 요청 밖의 행에는 붙지 않는다', async () => {
    const audit = new AuditService(db);
    await runInRequestContext({ requestId: 'req-2' }, () => audit.record({ action: 'space.create', targetType: 'space', detail: { name: '팀' } }));
    await audit.record({ action: 'llm.conversation.purge', targetType: 'system' });
    const rows = await db.select({ detail: auditEvents.detail }).from(auditEvents);
    for (const r of rows) expect(JSON.stringify(r.detail ?? {})).not.toContain('jti');
  });

  it('**부른 쪽이 같은 이름의 값을 넣어도 요청의 토큰이 이긴다** — 감사의 "어느 토큰으로"를 흉내 낼 수 없다', async () => {
    const audit = new AuditService(db);
    await runInRequestContext({ requestId: 'req-3' }, async () => {
      setRequestToken(TOKEN);
      await audit.record({ action: 'space.create', targetType: 'space', detail: { jti: 'forged' } });
    });
    const [row] = await db.select({ detail: auditEvents.detail }).from(auditEvents);
    expect(row!.detail).toEqual({ jti: TOKEN });
  });
});
