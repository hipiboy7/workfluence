import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DOCUMENT_SCHEMA_VERSION, type AppEnv, type DocNode } from '@workfluence/shared';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { blobPath } from '../attachments/domain/blob-path';
import { databaseUrl, loadEnv } from '../config/config.module';
import { attachments } from '../db/schema';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { PagesService } from '../pages/pages.service';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { auditPurge } from './audit-purge';
import { searchReindex } from './reindex';
import { trashPurge } from './trash-purge';

/**
 * B등급 — **월간 작업** (P13 D.2, FR-1410·1411). 실제 PostgreSQL. 운영에서는 이것들이 compose의 `tools`로 앱 이미지 안에서 돈다.
 * **시험 DB를 넘긴다** — 이 함수들은 인자가 없으면 `.env`의 DB에 붙는다. 시험에서 그렇게 부르면 개발 DB를 지운다
 */

let db: TestDb;
let storage: string;
let userId = '';
let spaceId = '';
let pages: PagesService;

const envFor = (over: Partial<AppEnv> = {}): AppEnv =>
  ({ ...loadEnv(), WF_ENV: 'test', WF_STORAGE_PATH: storage, WF_TRASH_RETENTION_DAYS: 30, WF_AUDIT_RETENTION_DAYS: 365, ...over }) as AppEnv;
const run = <T>(job: (env: AppEnv, url: string) => Promise<T>, over: Partial<AppEnv> = {}) => {
  const env = envFor(over);
  return job(env, databaseUrl(env));
};
const doc = (t: string): DocNode => ({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const count = async (q: ReturnType<typeof sql>) => Number((await db.execute<{ n: number }>(q)).rows[0].n);

beforeAll(async () => {
  ({ db } = await openTestDb());
  storage = await mkdtemp(join(tmpdir(), 'wf-cli-'));
});
afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
  await closeTestDb();
});
beforeEach(async () => {
  await resetTables(db);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const r = await db.execute<{ id: string }>(
    sql`INSERT INTO users (username, display_name, role, status, password_hash) VALUES ('cli-a', 'cli-a', 'admin', 'active', 'x') RETURNING id`,
  );
  userId = r.rows[0].id;
  const spaces = new SpacesService(db);
  pages = new PagesService(db, spaces, new NotificationsService(db, new InAppChannel()));
  spaceId = (await spaces.create({ name: '정리방', kind: 'personal', categoryId: null, description: '' }, { id: userId, role: 'admin' })).id;
});
afterEach(() => vi.restoreAllMocks());

describe('휴지통 정리 (trash-purge)', () => {
  it('**보존 기간을 넘긴 것만 지운다** — 첨부 파일까지, 감사로그에 남긴다', async () => {
    const old = await db.transaction((tx) => pages.create({ spaceId, parentId: null, title: '오래 지운 문서', content: doc('옛') }, { id: userId, role: 'admin' }, tx));
    const recent = await db.transaction((tx) => pages.create({ spaceId, parentId: null, title: '막 지운 문서', content: doc('새') }, { id: userId, role: 'admin' }, tx));
    await db.execute(sql`UPDATE pages SET deleted_at = now() - interval '40 days' WHERE id = ${old.id}`);
    await db.execute(sql`UPDATE pages SET deleted_at = now() - interval '5 days' WHERE id = ${recent.id}`);
    const sha = 'a'.repeat(64);
    await db.insert(attachments).values({ pageId: old.id, sha256: sha, filename: 'x.txt', mime: 'text/plain', size: 1, uploadedBy: userId });
    const file = blobPath(storage, sha);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'x');

    await run(trashPurge);

    expect(await count(sql`SELECT count(*)::int AS n FROM pages WHERE id = ${old.id}`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM pages WHERE id = ${recent.id}`)).toBe(1);
    await expect(stat(file)).rejects.toThrow();
    expect(await count(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'trash.purge'`)).toBe(1);
  });
});

describe('감사로그 정리 (audit-purge)', () => {
  it('**보존 기간 전의 기록만 지우고, 지웠다는 것도 기록한다**', async () => {
    await db.execute(sql`INSERT INTO audit_events (action, target_type, created_at) VALUES ('auth.logout', 'old', now() - interval '400 days')`);
    await db.execute(sql`INSERT INTO audit_events (action, target_type) VALUES ('auth.logout', 'recent')`);

    await run(auditPurge);

    expect(await count(sql`SELECT count(*)::int AS n FROM audit_events WHERE target_type = 'old'`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM audit_events WHERE target_type = 'recent'`)).toBe(1);
    const purge = await db.execute<{ d: { deleted: number } }>(sql`SELECT detail AS d FROM audit_events WHERE action = 'audit.purge'`);
    expect(purge.rows.map((r) => r.d.deleted)).toEqual([1]);
  });
});

describe('검색 재색인 (reindex)', () => {
  it('상한 검색 본문을 정본에서 다시 만든다', async () => {
    const p = await db.transaction((tx) => pages.create({ spaceId, parentId: null, title: '재색인 문서', content: doc('다시 찾아질 글') }, { id: userId, role: 'admin' }, tx));
    await db.execute(sql`UPDATE pages SET search_text = 'stale' WHERE id = ${p.id}`);

    await run(searchReindex);

    const r = await db.execute<{ t: string }>(sql`SELECT search_text AS t FROM pages WHERE id = ${p.id}`);
    expect(r.rows[0].t).toContain('다시 찾아질 글');
  });
});
