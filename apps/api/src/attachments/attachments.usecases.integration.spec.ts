import type { AppEnv } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { auditEvents } from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person, teamPage } from '../test/people';
import { AttachmentsService, type UploadedFileLike } from './attachments.service';
import { AttachmentUseCases } from './attachments.usecases';
import { LocalDiskStorage } from './storage/local.storage';
import { PassThroughScanner } from './storage/storage.provider';

/** 첨부의 유스케이스 (P3_설계서_Content 5절, FR-419 · docs/spinoff/public-api 계획서 7.1절). B등급 — 실제 PostgreSQL + 임시 디렉토리 */

let db: TestDb;
let root: string;
let spacesSvc: SpacesService;
let uc: AttachmentUseCases;
const META = { ip: '10.0.0.11' };
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
const file = (originalname = 'report.pdf'): UploadedFileLike => {
  const buffer = Buffer.from('%PDF-1.4 내용');
  return { originalname, mimetype: 'application/pdf', size: buffer.length, buffer };
};

beforeAll(async () => {
  ({ db } = await openTestDb());
  root = await mkdtemp(join(tmpdir(), 'wf-att-uc-'));
  const env = { WF_STORAGE_PATH: root, WF_UPLOAD_MAX_MB: 20 } as unknown as AppEnv;
  spacesSvc = new SpacesService(db);
  const svc = new AttachmentsService(db, new LocalDiskStorage(env), new PassThroughScanner(), env, spacesSvc, new SettingsService(db, env));
  uc = new AttachmentUseCases(svc, new AuditService(db), db);
});
afterAll(async () => {
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => resetTables(db));

describe('올리기', () => {
  it('올리고 감사에 페이지·파일명·크기·IP를 남긴다', async () => {
    const me = await person(db, 'me');
    const { pageId } = await teamPage(db, spacesSvc, me);
    const view = await uc.upload(pageId, file(), me, META);
    const [r] = await rows('attachment.upload');
    expect(r).toMatchObject({ actorId: me.id, targetType: 'attachment', targetId: view.id, ip: META.ip });
    expect(r!.detail).toEqual({ pageId, filename: 'report.pdf', size: view.size });
  });

  it('받지 않는 파일이면 막히고 감사가 남지 않는다', async () => {
    const me = await person(db, 'me');
    const { pageId } = await teamPage(db, spacesSvc, me);
    await expect(uc.upload(pageId, file('x.exe'), me, META)).rejects.toThrow();
    expect(await rows('attachment.upload')).toHaveLength(0);
  });
});

describe('내려받기 (FR-419) — 읽기지만 무엇을 가져갔는지 남는다', () => {
  it('내용을 돌려주고 감사에 남긴다', async () => {
    const me = await person(db, 'me');
    const { pageId } = await teamPage(db, spacesSvc, me);
    const view = await uc.upload(pageId, file(), me, META);
    const { row, data } = await uc.download(view.id, me, META);
    expect(row.filename).toBe('report.pdf');
    expect(data.toString()).toBe('%PDF-1.4 내용');
    const [r] = await rows('attachment.download');
    expect(r).toMatchObject({ actorId: me.id, targetId: view.id, ip: META.ip, detail: { pageId, filename: 'report.pdf' } });
  });

  it('볼 수 없는 사람은 막히고 감사가 남지 않는다', async () => {
    const owner = await person(db, 'owner');
    const other = await person(db, 'other');
    const { pageId } = await teamPage(db, spacesSvc, owner);
    const view = await uc.upload(pageId, file(), owner, META);
    await expect(uc.download(view.id, other, META)).rejects.toThrow();
    expect(await rows('attachment.download')).toHaveLength(0);
  });
});

describe('지우기', () => {
  it('지우고 감사에 페이지·파일명을 남긴다', async () => {
    const me = await person(db, 'me');
    const { pageId } = await teamPage(db, spacesSvc, me);
    const view = await uc.upload(pageId, file(), me, META);
    await uc.remove(view.id, me, META);
    const [r] = await rows('attachment.delete');
    expect(r).toMatchObject({ actorId: me.id, targetId: view.id, ip: META.ip, detail: { pageId, filename: 'report.pdf' } });
  });
});
