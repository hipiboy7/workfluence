import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenApi,
  createUserDto,
  listLimitDto,
  listUsersDto,
  policyPatchDto,
  userGrantsDto,
  auditQueryDto,
  v1AddMemberDto,
  v1CategoryDto,
  v1CommentDto,
  v1CommentUpdateDto,
  v1CreatePageDto,
  v1CreateSpaceDto,
  v1LabelDto,
  v1MemberRoleDto,
  v1MovePageDto,
  v1PageQuery,
  v1SearchQuery,
  v1SpaceListQuery,
  v1SpaceStatusDto,
  v1TemplateDto,
  v1TemplateUpdateDto,
  v1UpdatePageDto,
  v1UpdateSpaceDto,
  V1_OPENAPI_INFO,
  V1_OPERATIONS,
  type AppEnv,
} from '@workfluence/shared';
import type { z } from 'zod';
import { API_ADMIN_KEY } from '../api-tokens/api-token.guard';
import { AttachmentsService } from '../attachments/attachments.service';
import { AttachmentUseCases } from '../attachments/attachments.usecases';
import { LocalDiskStorage } from '../attachments/storage/local.storage';
import { PassThroughScanner } from '../attachments/storage/storage.provider';
import { AuditService } from '../audit/audit.service';
import { CommentsService } from '../comments/comments.service';
import { CommentUseCases } from '../comments/comments.usecases';
import { RevocationBus } from '../common/revocation.bus';
import { loadEnv } from '../config/config.module';
import { notifications } from '../db/schema';
import { LabelsService } from '../labels/labels.service';
import { LabelUseCases } from '../labels/labels.usecases';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { PagesService } from '../pages/pages.service';
import { PageUseCases } from '../pages/pages.usecases';
import { SearchService } from '../search/search.service';
import { PolicyUseCases } from '../settings/policy.usecases';
import { SettingsService } from '../settings/settings.service';
import { CategoryUseCases } from '../spaces/categories.usecases';
import { SpacesService } from '../spaces/spaces.service';
import { SpaceUseCases } from '../spaces/spaces.usecases';
import { TemplatesService } from '../templates/templates.service';
import { TemplateUseCases } from '../templates/templates.usecases';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { TrashService } from '../trash/trash.service';
import { TrashUseCases } from '../trash/trash.usecases';
import { UsersService } from '../users/users.service';
import { UserUseCases } from '../users/users.usecases';
import { V1AuditController, V1PolicyController, V1UsersController } from './v1-admin.controller';
import { V1AttachmentsController, V1CommentsController, V1LabelsController } from './v1-content.controller';
import { V1NotificationsController, V1TemplatesController, V1TrashController } from './v1-misc.controller';
import { V1OpenApiController } from './v1-openapi.controller';
import { V1PagesController } from './v1-pages.controller';
import { V1SearchController } from './v1-search.controller';
import { V1CategoriesController, V1SpacesController } from './v1-spaces.controller';
import { V1Module } from './v1.module';

/**
 * 공개 API v1의 **계약** (docs/spinoff/public-api 설계서 FR-2220·2221). B등급 — 실제 PostgreSQL.
 * ① 경로 표(`V1_OPERATIONS`) ↔ 실제 컨트롤러 경로가 **양방향으로 같다**(메서드·경로·`admin` 표시까지) — 경로를 더하고 명세를 안 고치면, 또는 반대면 깨진다.
 * ② `GET /api/v1/openapi.json`은 인증 없이 그 표에서 만든 문서를 준다.
 * ③ **실제 응답이 응답 스키마를 지킨다** — 컨트롤러를 실제로 불러 그 결과를 명세의 응답 스키마로 검증한다. 응답을 바꾸고 스키마를 안 고치면 깨진다.
 */

const info = { ...V1_OPENAPI_INFO };
const KINDS: Record<number, string> = { [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PATCH]: 'patch', [RequestMethod.PUT]: 'put', [RequestMethod.DELETE]: 'delete' };

type Route = { key: string; admin: boolean; cls: string };
const joinPath = (...parts: string[]) => '/' + parts.flatMap((p) => p.split('/')).filter(Boolean).join('/');

/** Nest의 라우트 표시(메타데이터)에서 실제 경로 표를 읽는다 — 우리가 명세에 적은 것이 아니라 서버가 실제로 받는 것 */
function actualRoutes(): Route[] {
  const controllers = Reflect.getMetadata('controllers', V1Module) as (new (...a: never[]) => object)[];
  const out: Route[] = [];
  for (const C of controllers) {
    const base = Reflect.getMetadata(PATH_METADATA, C) as string;
    for (const name of Object.getOwnPropertyNames(C.prototype)) {
      const h = (C.prototype as Record<string, unknown>)[name];
      if (name === 'constructor' || typeof h !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, h) as number | undefined;
      if (method === undefined) continue;
      const sub = (Reflect.getMetadata(PATH_METADATA, h) as string) ?? '/';
      const full = joinPath(base, sub).replace(/:(\w+)/g, '{$1}').replace(/^\/api\/v1/, '') || '/';
      const admin = (Reflect.getMetadata(API_ADMIN_KEY, h) ?? Reflect.getMetadata(API_ADMIN_KEY, C)) === true;
      out.push({ key: `${KINDS[method]} ${full}`, admin, cls: C.name });
    }
  }
  return out;
}

describe('경로 표 ↔ 실제 컨트롤러 (FR-2221)', () => {
  const actual = actualRoutes();
  const listed = V1_OPERATIONS.map((o) => `${o.method} ${o.path}`);

  it('실제 경로 가운데 명세에 없는 것이 없다', () => {
    expect(actual.map((r) => r.key).filter((k) => !listed.includes(k))).toEqual([]);
  });

  it('명세 경로 가운데 실제로 없는 것이 없다', () => {
    const real = actual.map((r) => r.key);
    expect(listed.filter((k) => !real.includes(k))).toEqual([]);
  });

  it('경로가 겹치지 않는다 — 한 경로가 두 번 올라 있지 않다', () => {
    const keys = actual.map((r) => r.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('`admin` 표시가 명세와 실제에서 같다 — 가드가 요구하는 scope와 명세가 말하는 scope가 같다', () => {
    for (const r of actual) {
      const op = V1_OPERATIONS.find((o) => `${o.method} ${o.path}` === r.key)!;
      expect(!!op.admin, r.key).toBe(r.admin);
    }
  });
});

describe('GET /api/v1/openapi.json', () => {
  it('**인증 없이** 경로 표에서 만든 문서를 준다', () => {
    const ctrl = new V1OpenApiController();
    expect(ctrl.get()).toEqual(buildOpenApi(V1_OPERATIONS, info));
    // 토큰 가드가 없다 — 토큰 없는 요청이 닿는다
    expect(Reflect.getMetadata('__guards__', V1OpenApiController)).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', V1OpenApiController.prototype.get)).toBeUndefined();
  });
});

// ---- 실제 응답이 스키마를 지킨다 ----

let db: TestDb;
let storageRoot: string;
const covered = new Set<string>();
const req = { ip: '10.0.0.40' } as never;
const md = v1PageQuery.parse({});
const live = { hasLiveEditors: vi.fn().mockReturnValue(false) };

/** 실제 응답을 그 경로의 응답 스키마로 검증한다 — 어긋나면 어느 경로의 어느 칸인지 말한다 */
function conform(opId: string, value: unknown): void {
  const op = V1_OPERATIONS.find((o) => o.id === opId);
  if (!op) throw new Error(`명세에 없는 경로: ${opId}`);
  if (!('safeParse' in op.response)) throw new Error(`${opId}는 JSON 응답이 아니다`);
  const r = (op.response as z.ZodType).safeParse(JSON.parse(JSON.stringify(value ?? null)));
  expect(r.success, `${opId}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`).toBe(true);
  covered.add(opId);
}

let spacesSvc: SpacesService;
let c: Record<string, any>;

beforeAll(async () => {
  ({ db } = await openTestDb());
  storageRoot = await mkdtemp(join(tmpdir(), 'wf-v1-contract-'));
  const env = { WF_STORAGE_PATH: storageRoot, WF_UPLOAD_MAX_MB: 20, WF_SESSION_IDLE_MINUTES: 30, WF_SESSION_ABSOLUTE_HOURS: 12, WF_TRASH_RETENTION_DAYS: 30, WF_AUDIT_RETENTION_DAYS: 365 } as unknown as AppEnv;
  const bus = new RevocationBus();
  const settings = new SettingsService(db, env);
  const audit = new AuditService(db, settings);
  spacesSvc = new SpacesService(db);
  const notif = new NotificationsService(db, new InAppChannel());
  const pagesSvc = new PagesService(db, spacesSvc, notif);
  const cats = new CategoryUseCases(audit, db);
  const commentsSvc = new CommentsService(db, spacesSvc, notif);
  const labelsSvc = new LabelsService(db, spacesSvc);
  const attSvc = new AttachmentsService(db, new LocalDiskStorage(env), new PassThroughScanner(), env, spacesSvc, settings);
  const tplSvc = new TemplatesService(db);
  const trashSvc = new TrashService(db, spacesSvc);
  const usersSvc = new UsersService(db, new SettingsService(db, loadEnv()), bus);
  c = {
    pages: new V1PagesController(pagesSvc, new PageUseCases(pagesSvc, audit, {} as never, { notify: vi.fn() } as never, spacesSvc, db), spacesSvc, live),
    spaces: new V1SpacesController(spacesSvc, new SpaceUseCases(spacesSvc, audit, db), cats),
    categories: new V1CategoriesController(cats),
    comments: new V1CommentsController(commentsSvc, new CommentUseCases(commentsSvc, audit, { notify: vi.fn().mockResolvedValue(undefined) } as never, db)),
    labels: new V1LabelsController(labelsSvc, new LabelUseCases(labelsSvc, audit, db)),
    attachments: new V1AttachmentsController(attSvc, new AttachmentUseCases(attSvc, audit, db)),
    search: new V1SearchController(new SearchService(db), spacesSvc),
    templates: new V1TemplatesController(tplSvc, new TemplateUseCases(tplSvc, audit, db)),
    trash: new V1TrashController(trashSvc, new TrashUseCases(trashSvc, audit, db)),
    notes: new V1NotificationsController(notif),
    users: new V1UsersController(usersSvc, new UserUseCases(usersSvc, audit, spacesSvc, notif, bus, db)),
    policy: new V1PolicyController(new PolicyUseCases(settings, audit, db)),
    audit: new V1AuditController(audit),
  };
});
afterAll(async () => {
  await closeTestDb();
  await rm(storageRoot, { recursive: true, force: true });
});
beforeEach(() => resetTables(db));

describe('실제 응답이 응답 스키마를 지킨다 (FR-2221)', () => {
  it('스페이스·분류·Crew', async () => {
    const owner = await person(db, 'owner');
    const bob = await person(db, 'bob');
    const cat = await c.categories.create(v1CategoryDto.parse({ name: '운영' }), owner, req);
    conform('categories.create', cat);
    conform('categories.list', await c.categories.list(owner));
    conform('categories.rename', await c.categories.rename(cat.id, v1CategoryDto.parse({ name: '운영팀' }), owner, req));
    const sp = await c.spaces.create(v1CreateSpaceDto.parse({ name: '장애 보고', category: '운영팀' }), owner, req);
    conform('spaces.create', sp);
    conform('spaces.list', await c.spaces.list(v1SpaceListQuery.parse({}), owner));
    conform('spaces.get', await c.spaces.get(sp.id, owner));
    conform('spaces.update', await c.spaces.update(sp.id, v1UpdateSpaceDto.parse({ description: '설명' }), owner, req));
    conform('spaces.addMember', await c.spaces.addMember(sp.id, v1AddMemberDto.parse({ username: 'bob' }), owner, req));
    conform('spaces.members', await c.spaces.members(sp.id, owner));
    conform('spaces.setMemberRole', await c.spaces.changeMemberRole(sp.id, 'bob', v1MemberRoleDto.parse({ role: 'viewer' }), owner, req));
    conform('spaces.removeMember', await c.spaces.removeMember(sp.id, bob.id, owner, req));
    conform('spaces.setStatus', await c.spaces.changeStatus(sp.id, v1SpaceStatusDto.parse({ status: 'suspended' }), owner, req));
    conform('spaces.setStatus', await c.spaces.changeStatus(sp.id, v1SpaceStatusDto.parse({ status: 'active' }), owner, req));
    conform('categories.delete', await c.categories.remove(cat.id, owner, req));
    conform('spaces.delete', await c.spaces.remove(sp.id, owner, req));
  });

  it('페이지·버전·비교·검색', async () => {
    const owner = await person(db, 'owner');
    const sp = await c.spaces.create(v1CreateSpaceDto.parse({ name: '장애 보고' }), owner, req);
    const page = await c.pages.create(v1CreatePageDto.parse({ space: sp.id, title: '첫 글', body: '# 제목\n\n본문 내용' }), md, owner, req);
    conform('pages.create', page);
    const child = await c.pages.create(v1CreatePageDto.parse({ space: sp.id, title: '하위', body: '하위 본문', parentId: page.id }), md, owner, req);
    conform('pages.tree', await c.pages.list({ space: sp.id, limit: 200 }, owner));
    conform('pages.get', await c.pages.get(child.id, md, owner));
    conform('pages.get', await c.pages.get(child.id, v1PageQuery.parse({ format: 'json' }), owner));
    conform('pages.update', await c.pages.update(page.id, v1UpdatePageDto.parse({ body: '바뀐 본문' }), md, owner, req));
    conform('pages.move', await c.pages.move(child.id, v1MovePageDto.parse({ parentId: null }), owner, req));
    conform('pages.versions', await c.pages.versions(page.id, owner));
    conform('pages.version', await c.pages.version(page.id, 1, md, owner));
    conform('pages.diff', await c.pages.diff(page.id, 1, 2, owner));
    conform('pages.restoreVersion', await c.pages.restore(page.id, 1, md, owner, req));
    conform('search.find', await c.search.find(v1SearchQuery.parse({ q: '본문' }), owner));
    conform('pages.delete', await c.pages.remove(child.id, owner, req));
    conform('trash.pages', await c.trash.pages(listLimitDto.parse({}), owner));
    conform('trash.restorePage', await c.trash.restorePage(child.id, owner, req));
  });

  it('댓글·라벨·첨부', async () => {
    const owner = await person(db, 'owner');
    const sp = await c.spaces.create(v1CreateSpaceDto.parse({ name: '장애 보고' }), owner, req);
    const page = await c.pages.create(v1CreatePageDto.parse({ space: sp.id, title: '글', body: '본문' }), md, owner, req);
    const cm = await c.comments.create(page.id, v1CommentDto.parse({ body: '댓글입니다' }), md, owner, req);
    conform('comments.create', cm);
    conform('comments.list', await c.comments.list(page.id, md, owner));
    conform('comments.update', await c.comments.update(cm.id, v1CommentUpdateDto.parse({ body: '고친 댓글' }), md, owner, req));
    conform('comments.delete', await c.comments.remove(cm.id, owner, req));
    const label = await c.labels.attach(page.id, v1LabelDto.parse({ name: '장애' }), owner, req);
    conform('labels.attach', label);
    conform('labels.list', await c.labels.all(listLimitDto.parse({})));
    conform('labels.forPage', await c.labels.forPage(page.id, owner));
    conform('labels.pages', await c.labels.pages('장애', listLimitDto.parse({}), owner));
    conform('labels.detach', await c.labels.detach(page.id, '장애', owner, req));
    const att = await c.attachments.upload(page.id, undefined, { filename: '회의록.txt', content: '안건' }, owner, req);
    conform('attachments.upload', att);
    conform('attachments.list', await c.attachments.list(page.id, owner));
    conform('attachments.delete', await c.attachments.remove(att.id, owner, req));
  });

  it('템플릿·휴지통(스페이스)·알림', async () => {
    const admin = await person(db, 'adm', 'admin');
    const owner = await person(db, 'owner');
    const t = await c.templates.create(v1TemplateDto.parse({ name: '회의록', body: '## 안건' }), md, admin, req);
    conform('templates.create', t);
    conform('templates.list', await c.templates.list(md, owner));
    conform('templates.update', await c.templates.update(t.id, v1TemplateUpdateDto.parse({ description: '설명' }), md, admin, req));
    conform('templates.delete', await c.templates.remove(t.id, admin, req));

    const sp = await c.spaces.create(v1CreateSpaceDto.parse({ name: '지울 곳' }), owner, req);
    await c.spaces.remove(sp.id, owner, req);
    conform('trash.spaces', await c.trash.spaces(listLimitDto.parse({}), admin));
    conform('trash.restoreSpace', await c.trash.restoreSpace(sp.id, admin, req));

    const [n] = await db.insert(notifications).values({ userId: owner.id, kind: 'mention' }).returning();
    await db.insert(notifications).values({ userId: owner.id, kind: 'mention' });
    conform('notifications.list', await c.notes.list(listLimitDto.parse({}), owner));
    conform('notifications.unreadCount', await c.notes.unread(owner));
    conform('notifications.read', await c.notes.read(n!.id, owner));
    conform('notifications.readAll', await c.notes.readAll(owner));
  });

  it('관리 — 사용자·정책·감사', async () => {
    const root = await person(db, 'sys', 'root');
    const made = await c.users.create(createUserDto.parse({ username: 'made', displayName: '만듦', email: 'made@example.internal', password: 'Made-pw-2026', role: 'member' }), root, req);
    conform('users.create', made);
    conform('users.list', await c.users.list(listUsersDto.parse({})));
    conform('users.suspend', await c.users.suspend(made.id, root, req));
    conform('users.unsuspend', await c.users.unsuspend(made.id, root, req));
    conform('users.unlock', await c.users.unlock(made.id, root, req));
    conform('users.setRole', await c.users.changeRole(made.id, { role: 'admin' }, root, req));
    conform('users.setGrants', await c.users.changeGrants(made.id, userGrantsDto.parse({ grants: ['llm.manage'] }), root, req));
    conform('users.terminateSessions', await c.users.terminateSessions(made.id, root, req));
    const [pending] = await db.insert((await import('../db/schema')).users).values({ username: 'wait', displayName: '대기', passwordHash: 'x', status: 'pending' }).returning();
    conform('users.approve', await c.users.approve(pending!.id, root, req));
    conform('settings.get', await c.policy.get(root));
    conform('settings.update', await c.policy.update(policyPatchDto.parse({ passwordMinLength: 10 }), root, req));
    conform('audit.list', await c.audit.list(auditQueryDto.parse({})));
  });

  it('JSON 응답인 모든 경로를 실제로 불러 확인했다 — 빠진 것이 있으면 여기서 드러난다', () => {
    const jsonOps = V1_OPERATIONS.filter((o) => 'safeParse' in o.response).map((o) => o.id);
    const BINARY_OR_SELF = ['spec.openapi'];
    expect(jsonOps.filter((id) => !covered.has(id) && !BINARY_OR_SELF.includes(id))).toEqual([]);
  });
});
