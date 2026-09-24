import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { loadEnv, type AppEnvToken } from '../config/config.module';
import type { MentionOutcome } from '../notifications/notifications.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import type { MailMessage, MailSender } from './mail.provider';
import { MentionMailService } from './mention-mail.service';

/**
 * B등급 통합 — 실제 PostgreSQL (감사 기록 때문이다).
 *
 * **이 파일이 생긴 이유.** 멘션 메일은 Phase 6부터 있었는데 테스트가 없어 라인 7%였다.
 * Phase 8이 "받는 사람마다 부른 사람이 다르다"(FR-905)를 넣으면서 이름을 고르는 규칙이
 * 둘(받는 사람별 `calledBy` → 호출부의 기본 이름)이 됐다. 틀리면 **남의 이름이 메일로 나가고,
 * 메일은 되돌릴 수 없다.**
 */

let db: TestDb;
let env: AppEnvToken;
let sent: MailMessage[];
let result: boolean;
const sender: MailSender = {
  send: async (m) => {
    sent.push(m);
    return result;
  },
};

const outcome = (recipients: MentionOutcome['recipients'], commentId: string | null = null): MentionOutcome => ({
  count: recipients.length,
  pageId: '00000000-0000-4000-8000-000000000001',
  commentId,
  recipients,
});
const to = (email: string, calledBy: string | null) => ({ email, displayName: email, calledBy, calledById: null });

beforeAll(async () => {
  ({ db } = await openTestDb());
  env = { ...loadEnv(), WF_MAIL_ENABLED: true, WF_PUBLIC_URL: 'https://wiki.example.internal' };
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  sent = [];
  result = true;
});

const svc = (over: Partial<AppEnvToken> = {}): MentionMailService => new MentionMailService(sender, { ...env, ...over }, new AuditService(db));

describe('누구의 이름으로 보내나 (P8 FR-905)', () => {
  it('**받는 사람별 `calledBy`가 기본 이름보다 앞선다** — 실시간 편집은 사람마다 부른 사람이 다르다', async () => {
    await svc().notify(outcome([to('a@example.internal', '김철수'), to('b@example.internal', '이영희')]), null, '회의록');
    expect(sent.map((m) => [m.to[0], m.subject])).toEqual([
      ['a@example.internal', '[위키] 김철수 님이 회원님을 불렀습니다'],
      ['b@example.internal', '[위키] 이영희 님이 회원님을 불렀습니다'],
    ]);
    expect(sent[0].text).toContain('김철수 님이 문서에서 회원님을 불렀습니다.');
  });

  it('`calledBy`가 없으면 호출부의 이름을 쓴다 — REST 저장·댓글은 요청한 사람이 부른 사람이다', async () => {
    await svc().notify(outcome([to('a@example.internal', null)], '00000000-0000-4000-8000-000000000002'), '박민수', '회의록');
    expect(sent[0].subject).toBe('[위키] 박민수 님이 회원님을 불렀습니다');
    expect(sent[0].text).toContain('박민수 님이 댓글에서 회원님을 불렀습니다.');
  });

  it('**둘 다 없으면 이름을 적지 않는다** — 틀린 이름보다 없는 이름이 낫다 (FR-901)', async () => {
    await svc().notify(outcome([to('a@example.internal', null)]), null, '회의록');
    expect(sent[0].subject).toBe('[위키] 문서에서 회원님이 불렸습니다');
    expect(sent[0].text.split('\n')[0]).toBe('문서에서 회원님이 불렸습니다.');
  });
});

describe('보내는 모양 (FR-753~756)', () => {
  it('한 통씩 따로 보내고, 본문은 싣지 않고 링크만 준다', async () => {
    await svc().notify(outcome([to('a@example.internal', null), to('b@example.internal', null)]), '박민수', '회의록');
    expect(sent.map((m) => m.to)).toEqual([['a@example.internal'], ['b@example.internal']]);
    expect(sent[0].text).toContain('문서: 회의록');
    expect(sent[0].text).toContain('바로 가기: https://wiki.example.internal/pages/00000000-0000-4000-8000-000000000001');
  });

  it('공개 주소가 없으면 링크 줄을 빼고 보낸다', async () => {
    await svc({ WF_PUBLIC_URL: '' }).notify(outcome([to('a@example.internal', null)]), '박민수', '회의록');
    expect(sent[0].text).not.toContain('바로 가기');
  });

  it('메일이 꺼져 있거나 받을 사람이 없으면 아무것도 하지 않는다', async () => {
    await svc({ WF_MAIL_ENABLED: false }).notify(outcome([to('a@example.internal', null)]), '박민수', '회의록');
    await svc().notify(outcome([]), '박민수', '회의록');
    expect(sent).toHaveLength(0);
  });

  it('**결과와 일으킨 사람을 감사로그에 남긴다** (FR-756·906) — 주소는 남기지 않는다', async () => {
    const [{ id }] = (await db.execute<{ id: string }>(sql`INSERT INTO users (username, display_name, role, status, password_hash) VALUES ('mailer', 'mailer', 'member', 'active', 'x') RETURNING id`)).rows;
    result = false;
    await svc().notify(outcome([to('a@example.internal', null)]), '박민수', '회의록', id);
    const r = await db.execute<{ action: string; actor_id: string | null; detail: Record<string, unknown> }>(
      sql`SELECT action, actor_id, detail FROM audit_events WHERE action LIKE 'mail.%'`,
    );
    expect(r.rows).toEqual([{ action: 'mail.fail', actor_id: id, detail: { recipients: 1, sent: 0, kind: 'mention' } }]);
    expect(JSON.stringify(r.rows)).not.toContain('example.internal');
  });

  it('**발송이 던져도 삼킨다** — 저장 응답을 막으면 안 된다 (FR-753)', async () => {
    const broken: MailSender = { send: async () => Promise.reject(new Error('boom')) };
    await expect(new MentionMailService(broken, env, new AuditService(db)).notify(outcome([to('a@example.internal', null)]), null, 'T')).resolves.toBeUndefined();
  });
});
