import type { AppEnv, Principal } from '@workfluence/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { pages, users } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { AttachmentsService, contentDisposition, type UploadedFileLike } from './attachments.service';
import { LocalDiskStorage } from './storage/local.storage';
import { PassThroughScanner, type AttachmentScanner } from './storage/storage.provider';

/** B등급 (P3_설계서_Content 5절). 실제 PostgreSQL + 임시 디렉토리. */

let db: TestDb;
let spacesSvc: SpacesService;
let svc: AttachmentsService;
let storage: LocalDiskStorage;
let root: string;

const env = (maxMb = 20) => ({ WF_STORAGE_PATH: root, WF_UPLOAD_MAX_MB: maxMb }) as unknown as AppEnv;
const file = (over: Partial<UploadedFileLike> = {}): UploadedFileLike => {
  const buffer = over.buffer ?? Buffer.from('%PDF-1.4 내용');
  return { originalname: 'report.pdf', mimetype: 'application/pdf', size: buffer.length, buffer, ...over, ...(over.buffer ? { size: over.size ?? buffer.length } : {}) };
};

async function user(username: string, role: 'root' | 'admin' | 'member' = 'member'): Promise<Principal> {
  const [u] = await db.insert(users).values({ username, displayName: username, passwordHash: 'x', role, status: 'active' }).returning();
  return { id: u.id, role };
}
async function page(spaceId: string, uid: string): Promise<string> {
  const [p] = await db
    .insert(pages)
    .values({ spaceId, parentId: null, title: 'T', position: 0, currentVersionNo: 1, searchText: '', createdBy: uid, updatedBy: uid })
    .returning();
  return p.id;
}
const eqId = (id: string) => eq(pages.id, id);
const team = (me: Principal) => spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);

beforeAll(async () => {
  ({ db } = await openTestDb());
  root = await mkdtemp(join(tmpdir(), 'wf-att-'));
  spacesSvc = new SpacesService(db);
  storage = new LocalDiskStorage(env());
  svc = new AttachmentsService(db, storage, new PassThroughScanner(), env(), spacesSvc);
});
afterAll(async () => {
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => resetTables(db));

describe('업로드 (FR-410~415)', () => {
  it('올린 파일이 해시 이름으로 저장되고 메타데이터가 남는다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);

    const view = await svc.upload(pid, file(), me);
    expect(view.filename).toBe('report.pdf');
    expect(view.size).toBeGreaterThan(0);
    expect(view.uploadedByName).toBe('me');

    const list = await svc.list(pid, me);
    expect(list).toHaveLength(1);
  });

  it('같은 내용을 두 번 올리면 파일은 한 벌이고 메타데이터만 는다 (FR-413)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);

    const a = await svc.upload(pid, file({ originalname: 'a.pdf' }), me);
    const b = await svc.upload(pid, file({ originalname: 'b.pdf' }), me);
    expect(a.id).not.toBe(b.id);
    expect((await svc.list(pid, me))).toHaveLength(2);

    // 둘 다 같은 내용을 가리키므로 하나를 지워도 다른 하나는 내려받힌다
    await svc.remove(a.id, me);
    expect((await svc.download(b.id, me)).data.toString()).toBe(file().buffer.toString());
  });

  it('화이트리스트를 벗어나면 400 (FR-414)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    await expect(svc.upload(pid, file({ originalname: 'x.exe', mimetype: 'application/pdf' }), me)).rejects.toThrow(/확장자/);
    await expect(svc.upload(pid, file({ originalname: 'x.pdf', mimetype: 'text/html' }), me)).rejects.toThrow(/맞지 않/);
  });

  it('빈 파일은 400이다 — 413(너무 크다)이 아니다 (자체 점검 #14)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    await expect(svc.upload(pid, file({ buffer: Buffer.alloc(0), size: 0 }), me)).rejects.toMatchObject({ status: 400 });
  });

  it('크기 상한을 넘으면 413 (FR-415)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const tiny = new AttachmentsService(db, storage, new PassThroughScanner(), env(0.000001), spacesSvc);
    await expect(tiny.upload(pid, file(), me)).rejects.toMatchObject({ status: 413 });
  });

  it('경로가 섞인 파일명도 저장 경로에 닿지 않는다 (FR-412)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const view = await svc.upload(pid, file({ originalname: '../../../../etc/passwd.pdf' }), me);
    // 이름은 메타데이터로 그대로 남지만, 내려받을 수 있다는 것이 곧 경로가 정상이라는 뜻이다
    expect(view.filename).toBe('../../../../etc/passwd.pdf');
    expect((await svc.download(view.id, me)).data.length).toBeGreaterThan(0);
  });

  it('이름은 맞는데 내용이 다르면 막는다 (FR-414b)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    // 윈도우 실행 파일을 `.pdf`로 이름 바꿔 올린다. **앞의 두 검사는 통과한다** — 이름도 형식도 맞다
    const renamed = file({ originalname: 'report.pdf', mimetype: 'application/pdf', buffer: Buffer.from('MZ\x90\x00executable') });
    await expect(svc.upload(pid, renamed, me)).rejects.toThrow(/내용이 \.pdf 형식이 아니다/);
    expect(await svc.list(pid, me)).toHaveLength(0);
  });

  it('저장하는 형식은 올린 쪽이 말한 것이 아니다 — 그 값이 다운로드 헤더가 된다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const view = await svc.upload(pid, file({ originalname: 'a.txt', mimetype: 'text/plain', buffer: Buffer.from('글자다') }), me);
    expect(view.mime).toBe('text/plain');
    expect((await svc.download(view.id, me)).row.mime).toBe('text/plain');
  });

  it('스캐너가 거부하면 저장하지 않는다 (FR-418 훅 지점)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const reject: AttachmentScanner = { scan: async () => ({ ok: false, reason: 'EICAR-Test' }) };
    const scanned = new AttachmentsService(db, storage, reject, env(), spacesSvc);
    await expect(scanned.upload(pid, file(), me)).rejects.toThrow(/EICAR-Test/);
    expect(await svc.list(pid, me)).toHaveLength(0);
  });
});

describe('권한 (FR-416)', () => {
  it('볼 수 없는 스페이스의 첨부는 없는 것이다', async () => {
    const owner = await user('owner');
    const other = await user('other');
    const sp = await team(owner);
    const pid = await page(sp.id, owner.id);
    const view = await svc.upload(pid, file(), owner);

    await expect(svc.download(view.id, other)).rejects.toThrow(/찾을 수 없다/);
    await expect(svc.list(pid, other)).rejects.toThrow(/찾을 수 없다/);
  });

  it('viewer는 읽지만 올리지 못한다', async () => {
    const owner = await user('owner');
    const viewer = await user('viewer');
    const sp = await team(owner);
    const pid = await page(sp.id, owner.id);
    await spacesSvc.addMember(sp.id, { username: 'viewer', role: 'viewer' }, owner);

    const view = await svc.upload(pid, file(), owner);
    expect((await svc.download(view.id, viewer)).row.id).toBe(view.id);
    await expect(svc.upload(pid, file(), viewer)).rejects.toThrow(/쓸 권한/);
    await expect(svc.remove(view.id, viewer)).rejects.toThrow(/권한/);
  });

  it('중지된 스페이스에서는 올린 사람도 지우지 못한다 (자체 점검 #4)', async () => {
    const admin = await user('adm', 'admin');
    const sp = await team(admin);
    const pid = await page(sp.id, admin.id);
    const view = await svc.upload(pid, file(), admin);
    await spacesSvc.changeStatus(sp.id, 'suspended', admin);
    // 중지는 "읽기 전용"이다. 작성자만 빠져나가면 판정이 두 벌이 된다
    await expect(svc.remove(view.id, admin)).rejects.toThrow(/쓸 권한/);
    expect((await svc.download(view.id, admin)).row.id).toBe(view.id);
  });

  it('지워진 페이지의 첨부는 보이지 않는다 (FR-427)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const view = await svc.upload(pid, file(), me);
    await db.update(pages).set({ deletedAt: new Date() }).where(eqId(pid));
    await expect(svc.download(view.id, me)).rejects.toThrow(/페이지를 찾을 수 없다/);
  });
});

describe('다운로드 헤더 (FR-417)', () => {
  it('따옴표·줄바꿈이 헤더를 깨뜨리지 못한다', () => {
    const h = contentDisposition('a"b\r\nX-Evil: 1.pdf');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.split('filename="')[1].split('"')[0]).not.toContain('"');
  });

  it('**언제나 attachment로 시작한다** — 브라우저가 우리 출처에서 내용을 실행하지 않게', () => {
    for (const name of ['a.pdf', '보고서.txt', 'x";inline;.pdf', 'a\r\nb.png', '한글 이름.hwp']) {
      expect(contentDisposition(name).startsWith('attachment;')).toBe(true);
    }
  });

  it('한글 이름은 RFC 5987로 나간다', () => {
    const h = contentDisposition('보고서.pdf');
    expect(h).toContain("filename*=UTF-8''");
    expect(h).toContain(encodeURIComponent('보고서.pdf'));
  });
});
