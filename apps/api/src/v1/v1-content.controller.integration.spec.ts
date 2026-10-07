import { BadRequestException, ForbiddenException, HttpException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v1CommentDto, v1CommentUpdateDto, v1LabelDto, v1PageQuery, type AppEnv } from '@workfluence/shared';
import { AttachmentsService } from '../attachments/attachments.service';
import { AttachmentUseCases } from '../attachments/attachments.usecases';
import { LocalDiskStorage } from '../attachments/storage/local.storage';
import { PassThroughScanner } from '../attachments/storage/storage.provider';
import { AuditService } from '../audit/audit.service';
import { CommentsService } from '../comments/comments.service';
import { CommentUseCases } from '../comments/comments.usecases';
import { auditEvents } from '../db/schema';
import { LabelsService } from '../labels/labels.service';
import { LabelUseCases } from '../labels/labels.usecases';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person, teamPage } from '../test/people';
import { V1AttachmentsController, V1CommentsController, V1LabelsController } from './v1-content.controller';

/**
 * 공개 API v1의 댓글·라벨·첨부 (docs/spinoff/public-api 설계서 3.3·3.5절 · FR-2210·2223). B등급 — 실제 PostgreSQL. 컨트롤러는 화면용과 같은 유스케이스를
 * 부르는 얇은 층이고, 여기서 보는 것은 **에이전트용 단순 계약**이다 — 본문만으로 댓글, 이름만으로 라벨, 텍스트나 base64로 첨부.
 */

let db: TestDb;
let storageRoot: string;
let spacesSvc: SpacesService;
let comments: V1CommentsController;
let labels: V1LabelsController;
let attachments: V1AttachmentsController;
const mail = { notify: vi.fn() };
const req = { ip: '10.0.0.19' } as never;
const md = v1PageQuery.parse({});
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));

beforeAll(async () => {
  ({ db } = await openTestDb());
  storageRoot = await mkdtemp(join(tmpdir(), 'wf-v1-att-'));
  const env = { WF_STORAGE_PATH: storageRoot, WF_UPLOAD_MAX_MB: 20 } as unknown as AppEnv;
  spacesSvc = new SpacesService(db);
  const audit = new AuditService(db);
  const commentsSvc = new CommentsService(db, spacesSvc, new NotificationsService(db, new InAppChannel()));
  comments = new V1CommentsController(commentsSvc, new CommentUseCases(commentsSvc, audit, mail as never, db));
  const labelsSvc = new LabelsService(db, spacesSvc);
  labels = new V1LabelsController(labelsSvc, new LabelUseCases(labelsSvc, audit, db));
  const attSvc = new AttachmentsService(db, new LocalDiskStorage(env), new PassThroughScanner(), env, spacesSvc, new SettingsService(db, env));
  attachments = new V1AttachmentsController(attSvc, new AttachmentUseCases(attSvc, audit, db));
});
afterAll(async () => {
  await closeTestDb();
  await rm(storageRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetTables(db);
  mail.notify.mockReset().mockResolvedValue(undefined);
});

const setup = async () => {
  const owner = await person(db, 'owner');
  const { pageId, spaceId } = await teamPage(db, spacesSvc, owner);
  return { owner, pageId, spaceId };
};
const viewerOf = async (spaceId: string, owner: Awaited<ReturnType<typeof person>>) => {
  const bob = await person(db, 'bob');
  await spacesSvc.addMember(spaceId, { username: 'bob', role: 'viewer' }, owner);
  return bob;
};
const codeOf = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(HttpException);
  const h = e as HttpException;
  const body = (typeof h.getResponse() === 'string' ? {} : h.getResponse()) as { code?: string };
  return { status: h.getStatus(), code: body.code };
};
const fakeRes = () => {
  const sent: { headers: Record<string, string>; body?: Buffer } = { headers: {} };
  const res = {
    setHeader(k: string, v: string) {
      sent.headers[k] = v;
      return res;
    },
    end(b: Buffer) {
      sent.body = b;
    },
  };
  return { sent, res: res as never };
};

describe('댓글 — 본문만으로 (FR-2223)', () => {
  it('본문만 주면 마크다운이 문서로 저장되고, 읽을 때 마크다운으로 나온다', async () => {
    const { owner, pageId } = await setup();
    const c = await comments.create(pageId, v1CommentDto.parse({ body: '**확인** 했습니다' }), md, owner, req);
    expect(c).toMatchObject({ pageId, parentId: null, author: 'owner', format: 'markdown', body: '**확인** 했습니다', canDelete: true });
    expect((await rows('comment.create'))[0]).toMatchObject({ actorId: owner.id, targetId: c.id, ip: '10.0.0.19' });
  });

  it('답글은 parentId로, 목록은 형식을 고른다', async () => {
    const { owner, pageId } = await setup();
    const a = await comments.create(pageId, v1CommentDto.parse({ body: '질문' }), md, owner, req);
    const b = await comments.create(pageId, v1CommentDto.parse({ body: '답', parentId: a.id }), md, owner, req);
    expect(b.parentId).toBe(a.id);
    const list = await comments.list(pageId, md, owner);
    expect(list.items.map((x) => [x.body, x.parentId])).toEqual([
      ['질문', null],
      ['답', a.id],
    ]);
    const json = await comments.list(pageId, v1PageQuery.parse({ format: 'json' }), owner);
    expect((json.items[0]!.body as { type: string }).type).toBe('doc');
  });

  it('고치고 지운다', async () => {
    const { owner, pageId } = await setup();
    const c = await comments.create(pageId, v1CommentDto.parse({ body: '처음' }), md, owner, req);
    expect((await comments.update(c.id, v1CommentUpdateDto.parse({ body: '고침' }), md, owner, req)).body).toBe('고침');
    await expect(comments.remove(c.id, owner, req)).resolves.toEqual({ ok: true });
    expect((await comments.list(pageId, md, owner)).items).toEqual([]);
  });

  it('멘션 메일은 화면용과 같은 길로 간다', async () => {
    const { owner, pageId, spaceId } = await setup();
    await person(db, 'carol', 'member', { email: 'carol@example.internal' });
    await spacesSvc.addMember(spaceId, { username: 'carol', role: 'editor' }, owner);
    await comments.create(pageId, v1CommentDto.parse({ body: '@carol 봐 주세요' }), md, owner, req);
    expect(mail.notify).toHaveBeenCalledTimes(1);
  });

  it('읽기만 하는 사람은 쓰지 못하고(403), 볼 수 없는 사람에게는 페이지가 없다(404)', async () => {
    const { owner, pageId, spaceId } = await setup();
    const bob = await viewerOf(spaceId, owner);
    const mallory = await person(db, 'mallory');
    await expect(comments.create(pageId, v1CommentDto.parse({ body: 'x' }), md, bob, req)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(comments.list(pageId, md, mallory)).rejects.toBeInstanceOf(NotFoundException);
    expect(await comments.list(pageId, md, bob)).toEqual({ items: [] });
  });
});

describe('라벨 — 이름으로', () => {
  it('이름만으로 붙이고, 페이지의 라벨과 전체 라벨을 본다', async () => {
    const { owner, pageId } = await setup();
    const l = await labels.attach(pageId, v1LabelDto.parse({ name: '운영' }), owner, req);
    expect(l).toMatchObject({ name: '운영' });
    expect(await labels.forPage(pageId, owner)).toEqual([l]);
    expect((await labels.all({ limit: 100 })).map((x) => x.name)).toContain('운영');
    expect((await rows('label.attach'))[0]).toMatchObject({ targetId: pageId, ip: '10.0.0.19' });
  });

  it('**이름으로 뗀다**(id로도) — 없으면 404 LABEL_NOT_FOUND', async () => {
    const { owner, pageId } = await setup();
    const a = await labels.attach(pageId, v1LabelDto.parse({ name: '운영' }), owner, req);
    await labels.attach(pageId, v1LabelDto.parse({ name: '장애' }), owner, req);
    await expect(labels.detach(pageId, ' 운영 ', owner, req)).resolves.toEqual({ ok: true });
    await expect(labels.detach(pageId, (await labels.forPage(pageId, owner))[0]!.id, owner, req)).resolves.toEqual({ ok: true });
    expect(await labels.forPage(pageId, owner)).toEqual([]);
    expect(await codeOf(labels.detach(pageId, a.name, owner, req))).toMatchObject({ status: 404, code: 'LABEL_NOT_FOUND' });
  });

  it('라벨로 페이지를 모아 본다 — 볼 수 있는 페이지만', async () => {
    const { owner, pageId } = await setup();
    await labels.attach(pageId, v1LabelDto.parse({ name: '운영' }), owner, req);
    const mallory = await person(db, 'mallory');
    expect((await labels.pages('운영', { limit: 100 }, owner)).items.map((h) => h.pageId)).toEqual([pageId]);
    expect((await labels.pages('운영', { limit: 100 }, mallory)).items).toEqual([]);
  });

  it('읽기만 하는 사람은 붙이지 못한다(403)', async () => {
    const { owner, pageId, spaceId } = await setup();
    const bob = await viewerOf(spaceId, owner);
    await expect(labels.attach(pageId, v1LabelDto.parse({ name: 'x' }), bob, req)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('첨부 — 텍스트나 base64로 올린다', () => {
  it('파일 이름과 글만으로 올리면 첨부가 되고, 본문에 넣을 주소(href)와 API 주소(url)를 준다', async () => {
    const { owner, pageId } = await setup();
    const a = await attachments.upload(pageId, undefined, { filename: '회의록.txt', content: '# 회의록\n안건 1' }, owner, req);
    expect(a).toMatchObject({ filename: '회의록.txt', pageId, uploadedByName: 'owner' });
    expect(a.url).toBe(`/api/v1/attachments/${a.id}`);
    expect(a.href).toBe(`/api/attachments/${a.id}`);
    expect((await rows('attachment.upload'))[0]).toMatchObject({ targetId: a.id, ip: '10.0.0.19', detail: { pageId, filename: '회의록.txt' } });
  });

  it('base64도 된다 — PDF는 바이트가 그대로 저장된다', async () => {
    const { owner, pageId } = await setup();
    const bytes = Buffer.from('%PDF-1.4 내용');
    const a = await attachments.upload(pageId, undefined, { filename: 'r.pdf', content: bytes.toString('base64'), encoding: 'base64' }, owner, req);
    const { sent, res } = fakeRes();
    await attachments.download(a.id, {}, owner, req, res);
    expect(sent.body?.equals(bytes)).toBe(true);
  });

  it('multipart로 온 파일(필드 file)도 같은 길이다', async () => {
    const { owner, pageId } = await setup();
    const buf = Buffer.from('안녕');
    const a = await attachments.upload(pageId, { originalname: '인사.txt', mimetype: 'text/plain', size: buf.length, buffer: buf }, undefined, owner, req);
    expect(a.filename).toBe('인사.txt');
  });

  it('파일도 내용도 없으면 400 — 무엇을 보내야 하는지 말한다', async () => {
    const { owner, pageId } = await setup();
    await expect(attachments.upload(pageId, undefined, undefined, owner, req)).rejects.toBeInstanceOf(BadRequestException);
    await expect(attachments.upload(pageId, undefined, { filename: 'a.txt' }, owner, req)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('허용되지 않는 종류는 400, 가장한 파일(이름은 pdf인데 내용이 아님)도 400', async () => {
    const { owner, pageId } = await setup();
    await expect(attachments.upload(pageId, undefined, { filename: 'a.exe', content: 'MZ' }, owner, req)).rejects.toBeInstanceOf(BadRequestException);
    await expect(attachments.upload(pageId, undefined, { filename: 'a.pdf', content: '그냥 글자' }, owner, req)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('목록과 지우기', async () => {
    const { owner, pageId } = await setup();
    const a = await attachments.upload(pageId, undefined, { filename: 'a.txt', content: '글' }, owner, req);
    expect((await attachments.list(pageId, owner)).items.map((x) => x.id)).toEqual([a.id]);
    await expect(attachments.remove(a.id, owner, req)).resolves.toEqual({ ok: true });
    expect((await attachments.list(pageId, owner)).items).toEqual([]);
  });

  it('읽기만 하는 사람은 올리지 못하고(403), 볼 수 없는 사람은 받지 못한다(404)', async () => {
    const { owner, pageId, spaceId } = await setup();
    const bob = await viewerOf(spaceId, owner);
    const a = await attachments.upload(pageId, undefined, { filename: 'a.txt', content: '글' }, owner, req);
    await expect(attachments.upload(pageId, undefined, { filename: 'b.txt', content: '글' }, bob, req)).rejects.toBeInstanceOf(ForbiddenException);
    const mallory = await person(db, 'mallory');
    await expect(attachments.download(a.id, {}, mallory, req, fakeRes().res)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('첨부 받기', () => {
  it('바이너리: 형식·파일 이름·nosniff·no-store 머리와 감사 (FR-417·419)', async () => {
    const { owner, pageId } = await setup();
    const a = await attachments.upload(pageId, undefined, { filename: '노트.txt', content: '안녕' }, owner, req);
    const { sent, res } = fakeRes();
    await attachments.download(a.id, {}, owner, req, res);
    expect(sent.body?.toString('utf8')).toBe('안녕');
    expect(sent.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(sent.headers['Cache-Control']).toBe('no-store');
    expect(sent.headers['Content-Disposition']).toMatch(/attachment/);
    expect((await rows('attachment.download'))[0]).toMatchObject({ targetId: a.id, ip: '10.0.0.19' });
  });

  it('**`format=json`이면 글은 utf8로, 바이너리는 base64로 JSON에 담아 준다** — 바이너리를 못 받는 에이전트용', async () => {
    const { owner, pageId } = await setup();
    const t = await attachments.upload(pageId, undefined, { filename: 'a.txt', content: '한글 글' }, owner, req);
    const p = await attachments.upload(pageId, undefined, { filename: 'a.pdf', content: Buffer.from('%PDF-1.4 x').toString('base64'), encoding: 'base64' }, owner, req);
    const { res } = fakeRes();
    const text = await attachments.download(t.id, { format: 'json' }, owner, req, res);
    expect(text).toMatchObject({ id: t.id, filename: 'a.txt', encoding: 'utf8', content: '한글 글' });
    const bin = await attachments.download(p.id, { format: 'json' }, owner, req, res);
    expect(bin).toMatchObject({ encoding: 'base64', content: Buffer.from('%PDF-1.4 x').toString('base64') });
  });

  it('JSON으로 담기에 너무 큰 파일은 413 — 바이너리로 받으라고 말한다', async () => {
    const { owner, pageId } = await setup();
    const big = Buffer.alloc(1_000_001, 'a');
    const a = await attachments.upload(pageId, { originalname: 'big.txt', mimetype: 'text/plain', size: big.length, buffer: big }, undefined, owner, req);
    await expect(attachments.download(a.id, { format: 'json' }, owner, req, fakeRes().res)).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});
