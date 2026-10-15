import {
  ASSIGNABLE_MEMBER_ROLES,
  POLICY_DEFAULTS,
  attachLabelDto,
  can,
  categoryAccess,
  createCommentDto,
  createPageDto,
  createSpaceDto,
  createTemplateDto,
  diffDocs,
  extractText,
  grantsForRole,
  isAdminRole,
  loginDto,
  movePageDto,
  spaceAccess,
  stampSchemaVersion,
  updatePageDto,
  updateSpaceDto,
  type AttachmentView,
  type AuditEventView,
  type CategoryView,
  type CommentView,
  type DocNode,
  type LabelView,
  type MeView,
  type NotificationView,
  type PageDiffView,
  type PageSummary,
  type PageTemplateView,
  type PageVersionView,
  type PageView,
  type Principal,
  type SearchHit,
  type SpaceMemberRole,
  type SpaceMemberView,
  type SpaceView,
  type TrashPageView,
  type TrashSpaceView,
  type UserView,
} from '@workfluence/shared';
import { ApiError, type ApiInit } from '../api';
import { buildSeed } from './seed';
import { DEMO_PASSWORD, clearState, loadState, newId, saveState, type DemoPage, type DemoSpace, type DemoState, type DemoUser } from './store';

/**
 * 스마트폰 시연판(F-015)의 **폰 안 서버** — 화면이 부르는 `/api/...`에 서버 대신 답한다. 서버와 **같은 공유 코드**로 판정한다: 스페이스 권한
 * (`spaceAccess`), 요청 검증(zod 계약 — 문서 허용 목록 포함), 버전 비교(`diffDocs`), 본문 글 뽑기(`extractText`). 감사로그도 같은 행위 이름으로
 * 남긴다. 실시간 편집·첨부 올리기·메일·사내 LLM·사내 계정은 없다(화면이 묻지 않거나 "시연판에 없다"로 답한다)
 */

let state: DemoState | null = null;
const db = (): DemoState => (state ??= loadState(() => buildSeed(new Date())));
const nowIso = () => new Date().toISOString();

/** **시연 데이터 처음으로** — 고친 것을 모두 버리고 시드로 돌아간다. 로그인도 풀린다 */
export function resetDemo(): void {
  clearState();
  state = buildSeed(new Date());
  saveState(state);
}

type Req = { method: string; path: string; query: URLSearchParams; body: unknown };
type Handler = (req: Req, params: string[]) => unknown;

const fail = (status: number, message: string): never => {
  throw new ApiError(status, { message });
};
const NOT_IN_DEMO = '시연판에서는 쓰지 않는 기능입니다 — 실제 시스템에는 있습니다';

type Schema<T> = {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
};

function parse<T>(schema: Schema<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new ApiError(400, { message: '입력이 올바르지 않다', issues: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) });
  return r.data;
}

// ---- 누가 ----

function me(): DemoUser {
  const s = db();
  const u = s.users.find((x) => x.id === s.sessionUserId);
  if (!u) return fail(401, '로그인이 필요하다');
  return u;
}
const principal = (u: DemoUser): Principal => ({ id: u.id, role: u.role, grants: u.grants });
const userName = (id: string | null) => (id ? (db().users.find((u) => u.id === id)?.displayName ?? '(삭제된 사용자)') : null);
const meView = (u: DemoUser): MeView => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  role: u.role,
  mustChangePassword: false,
  grants: grantsForRole(u.role, u.grants),
  hasPassword: true,
});

function audit(action: string, actorId: string | null, targetType: string | null, targetId: string | null, detail: Record<string, unknown> | null = null) {
  db().audit.push({ id: newId(), action, actorId, targetType, targetId, detail, createdAt: nowIso() });
}

// ---- 스페이스 ----

function memberRole(spaceId: string, userId: string): SpaceMemberRole | null {
  return db().members.find((m) => m.spaceId === spaceId && m.userId === userId)?.role ?? null;
}
const memberCount = (spaceId: string) => db().members.filter((m) => m.spaceId === spaceId).length;
const accessOf = (sp: DemoSpace, u: DemoUser) => spaceAccess(principal(u), sp, memberRole(sp.id, u.id), memberCount(sp.id));

function spaceView(sp: DemoSpace, u: DemoUser): SpaceView {
  const access = accessOf(sp, u);
  const cat = sp.categoryId ? db().categories.find((c) => c.id === sp.categoryId) : undefined;
  return {
    id: sp.id,
    key: sp.key,
    name: sp.name,
    description: access.canRead ? sp.description : '',
    kind: sp.kind,
    status: sp.status,
    suspendedByOwner: sp.status === 'suspended' && sp.suspendedByOwner,
    categoryId: cat?.id ?? null,
    categoryName: cat?.name ?? null,
    createdBy: sp.createdBy,
    createdByUsername: db().users.find((x) => x.id === sp.createdBy)?.username ?? '',
    memberCount: memberCount(sp.id),
    myRole: memberRole(sp.id, u.id),
    access,
    createdAt: sp.createdAt,
    updatedAt: sp.updatedAt,
  };
}

/** 읽을 수 있는 스페이스 — 없거나 못 읽으면 서버처럼 404 */
function readableSpace(id: string, u: DemoUser): DemoSpace {
  const sp = db().spaces.find((x) => x.id === id && !x.deletedAt);
  if (!sp || !accessOf(sp, u).canRead) return fail(404, '스페이스를 찾을 수 없다');
  return sp;
}
function writableSpace(id: string, u: DemoUser): DemoSpace {
  const sp = readableSpace(id, u);
  if (!accessOf(sp, u).canWrite) fail(403, sp.status === 'suspended' ? '중지된 스페이스는 읽기만 된다' : '이 스페이스에 쓸 권한이 없다');
  return sp;
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// ---- 페이지 ----

const head = (p: DemoPage) => p.versions[p.versions.length - 1];
const pageSummary = (p: DemoPage): PageSummary => ({
  id: p.id,
  spaceId: p.spaceId,
  parentId: p.parentId,
  title: head(p).title,
  position: p.position,
  currentVersionNo: head(p).no,
  updatedAt: p.updatedAt,
});
const pageView = (p: DemoPage): PageView => ({
  ...pageSummary(p),
  content: head(p).content,
  createdBy: p.createdBy,
  updatedBy: head(p).createdBy,
  createdAt: p.createdAt,
});

function readablePage(id: string, u: DemoUser): DemoPage {
  const p = db().pages.find((x) => x.id === id && !x.deletedAt);
  if (!p) return fail(404, '페이지를 찾을 수 없다');
  readableSpace(p.spaceId, u);
  return p;
}
function writablePage(id: string, u: DemoUser): DemoPage {
  const p = readablePage(id, u);
  writableSpace(p.spaceId, u);
  return p;
}

const livePages = (spaceId: string) => db().pages.filter((p) => p.spaceId === spaceId && !p.deletedAt);
function siblings(spaceId: string, parentId: string | null, except?: string) {
  return livePages(spaceId)
    .filter((p) => p.parentId === parentId && p.id !== except)
    .sort((a, b) => a.position - b.position);
}
function nextPosition(spaceId: string, parentId: string | null) {
  const sib = siblings(spaceId, parentId);
  return sib.length ? sib[sib.length - 1].position + 1024 : 1024;
}

/** 본문의 `@아이디`로 알림을 만든다 — 서버처럼 그 공간을 읽을 수 있는 다른 사람에게만, 이 저장에서 새로 생긴 이름만 */
const MENTION = /(^|[\s([{<"'`])@([a-z0-9._-]{2,64})/gu;
function mentionNames(doc: DocNode): string[] {
  return [...new Set([...extractText(doc).matchAll(MENTION)].map((m) => m[2].replace(/[.\-_]+$/, '')))];
}
function notifyMentions(doc: DocNode, before: DocNode | null, page: DemoPage, actor: DemoUser, commentId: string | null) {
  const old = new Set(before ? mentionNames(before) : []);
  const sp = db().spaces.find((x) => x.id === page.spaceId)!;
  for (const name of mentionNames(doc)) {
    if (old.has(name)) continue;
    const target = db().users.find((x) => x.username === name);
    if (!target || target.id === actor.id || !accessOf(sp, target).canRead) continue;
    db().notifications.push({ id: newId(), userId: target.id, kind: 'mention', pageId: page.id, commentId, actorId: actor.id, readAt: null, createdAt: nowIso() });
  }
}

function snippet(text: string, q: string): string {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  return at >= 0 ? text.slice(Math.max(at - 30, 0), Math.max(at - 30, 0) + 120) : text.slice(0, 120);
}

function canReadSpaceId(spaceId: string, u: DemoUser): boolean {
  const sp = db().spaces.find((x) => x.id === spaceId && !x.deletedAt);
  return !!sp && accessOf(sp, u).canRead;
}

function hitsOf(pages: DemoPage[], u: DemoUser, q: string, limit: number): SearchHit[] {
  return pages
    .filter((p) => !p.deletedAt && canReadSpaceId(p.spaceId, u))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit)
    .map((p) => {
      const sp = db().spaces.find((x) => x.id === p.spaceId)!;
      return { pageId: p.id, spaceId: sp.id, spaceName: sp.name, title: head(p).title, snippet: snippet(extractText(head(p).content), q), updatedAt: p.updatedAt };
    });
}

// ---- 사용자 ----

function userView(u: DemoUser): UserView {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    role: u.role,
    status: 'active',
    mustChangePassword: false,
    grants: grantsForRole(u.role, u.grants),
    createdAt: u.createdAt,
  };
}

function categoryView(c: DemoState['categories'][number], u: DemoUser): CategoryView {
  const using = db().spaces.filter((s) => s.categoryId === c.id);
  const otherSpaces = using.filter((s) => s.createdBy !== c.createdBy).length;
  const access = categoryAccess(principal(u), c, { otherSpaces });
  const seeUsage = access.canRename || c.createdBy === u.id;
  return { id: c.id, name: c.name, createdBy: c.createdBy, createdAt: c.createdAt, access, usage: seeUsage ? { spaces: using.length, otherSpaces } : null };
}

// ---- 경로표 ----

const ID = '([0-9a-f-]{36})';
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) => routes.push([method, new RegExp(`^${pattern.replace(/:id/g, ID)}$`), h]);

// 인증 (P1·P13). 시연 계정은 로그인 화면에 적혀 있다
on('GET', '/api/auth/config', () => ({ oidcEnabled: false, collabEnabled: false, resetMailEnabled: false }));
on('GET', '/api/auth/password-rules', () => ({ minLength: db().policy.passwordMinLength, minCharClasses: db().policy.passwordMinCharClasses }));
on('GET', '/api/auth/me', () => meView(me()));
on('POST', '/api/auth/login', (r) => {
  const dto = parse(loginDto, r.body);
  const u = db().users.find((x) => x.username === dto.username.toLowerCase());
  if (!u || dto.password !== DEMO_PASSWORD) {
    audit('auth.login.failure', u?.id ?? null, 'user', u?.id ?? null, { username: dto.username });
    return fail(401, '아이디 또는 비밀번호가 올바르지 않습니다');
  }
  db().sessionUserId = u.id;
  audit('auth.login.success', u.id, 'user', u.id, { method: 'local' });
  return meView(u);
});
on('POST', '/api/auth/logout', () => {
  const s = db();
  if (s.sessionUserId) audit('auth.logout', s.sessionUserId, 'user', s.sessionUserId);
  s.sessionUserId = null;
  return undefined;
});
for (const p of ['signup', 'find-id', 'recover-password', 'reset-mail', 'reset-password', 'email-help', 'change-password']) {
  on('POST', `/api/auth/${p}`, () => fail(400, NOT_IN_DEMO));
}

// 스페이스 (P2·P14·P15)
on('GET', '/api/spaces', (r) => {
  const u = me();
  const scope = r.query.get('scope') ?? 'personal';
  const q = r.query.get('q')?.trim().toLowerCase();
  const status = r.query.get('status');
  if (scope === 'all' && !can(principal(u), 'space.oversee')) fail(403, '전체 스페이스를 볼 권한이 없다');
  return db()
    .spaces.filter((s) => !s.deletedAt)
    .filter((s) => (scope === 'all' ? true : scope === 'personal' ? s.kind === 'personal' && s.createdBy === u.id : s.kind === 'team' && (memberRole(s.id, u.id) !== null || s.createdBy === u.id)))
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.key.toLowerCase().includes(q))
    .filter((s) => !status || s.status === status)
    .sort(byName)
    .map((s) => spaceView(s, u))
    .filter((v) => scope === 'all' || v.access.canRead);
});
on('GET', '/api/spaces/:id', (_r, [id]) => {
  const u = me();
  return spaceView(readableSpace(id, u), u);
});
on('POST', '/api/spaces', (r) => {
  const u = me();
  const dto = parse(createSpaceDto, r.body);
  const t = nowIso();
  const sp: DemoSpace = {
    id: newId(),
    key: `S${db().spaces.length + 1}`,
    name: dto.name,
    description: dto.description,
    kind: dto.kind,
    status: 'active',
    suspendedByOwner: false,
    categoryId: dto.categoryId,
    createdBy: u.id,
    createdAt: t,
    updatedAt: t,
    deletedAt: null,
  };
  db().spaces.push(sp);
  if (sp.kind === 'team') db().members.push({ spaceId: sp.id, userId: u.id, role: 'owner', createdAt: t });
  audit('space.create', u.id, 'space', sp.id, { name: sp.name, kind: sp.kind });
  return spaceView(sp, u);
});
on('PATCH', '/api/spaces/:id', (r, [id]) => {
  const u = me();
  const sp = readableSpace(id, u);
  if (!accessOf(sp, u).canEditInfo) fail(403, '이름·설명·분류는 주인과 관리자가 바꾼다');
  const dto = parse(updateSpaceDto, r.body);
  Object.assign(sp, { ...(dto.name !== undefined && { name: dto.name }), ...(dto.description !== undefined && { description: dto.description }), ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }), updatedAt: nowIso() });
  audit('space.update', u.id, 'space', sp.id, { ...dto });
  return spaceView(sp, u);
});
on('PATCH', '/api/spaces/:id/status', (r, [id]) => {
  const u = me();
  const sp = db().spaces.find((x) => x.id === id && !x.deletedAt) ?? fail(404, '스페이스를 찾을 수 없다');
  const a = accessOf(sp, u);
  if (!a.canChangeStatus) fail(403, '상태를 바꿀 권한이 없다');
  const want = (r.body as { status?: string })?.status === 'suspended' ? 'suspended' : 'active';
  const from = sp.status;
  sp.status = want;
  sp.suspendedByOwner = want === 'suspended' && a.isOwner && !isAdminRole(u.role);
  sp.updatedAt = nowIso();
  audit('space.status.change', u.id, 'space', sp.id, { from, to: want });
  return spaceView(sp, u);
});
on('DELETE', '/api/spaces/:id', (_r, [id]) => {
  const u = me();
  const sp = db().spaces.find((x) => x.id === id && !x.deletedAt) ?? fail(404, '스페이스를 찾을 수 없다');
  if (!accessOf(sp, u).canDelete) fail(403, '이 스페이스를 지울 수 없다');
  sp.deletedAt = nowIso();
  audit('space.delete', u.id, 'space', sp.id, { name: sp.name });
  return { ok: true };
});
on('GET', '/api/spaces/:id/members', (_r, [id]) => {
  const u = me();
  readableSpace(id, u);
  return db()
    .members.filter((m) => m.spaceId === id)
    .map((m): SpaceMemberView => {
      const x = db().users.find((y) => y.id === m.userId)!;
      return { userId: x.id, username: x.username, displayName: x.displayName, role: m.role, createdAt: m.createdAt };
    })
    .sort((a, b) => (a.displayName < b.displayName ? -1 : 1));
});
function manageCrew(id: string, u: DemoUser): DemoSpace {
  const sp = readableSpace(id, u);
  const a = accessOf(sp, u);
  if (!a.canManageMembers) fail(403, a.crewFrozen ? '관리자가 중지한 스페이스다 — Crew는 관리자가 바꾼다' : 'Crew를 바꿀 권한이 없다');
  return sp;
}
on('POST', '/api/spaces/:id/members', (r, [id]) => {
  const u = me();
  const sp = manageCrew(id, u);
  const b = (r.body ?? {}) as { username?: string; role?: string };
  const target = db().users.find((x) => x.username === b.username?.trim().toLowerCase()) ?? fail(404, '그 아이디의 사용자가 없다');
  if (!(ASSIGNABLE_MEMBER_ROLES as readonly string[]).includes(b.role ?? '')) fail(400, '역할은 editor·viewer다');
  if (memberRole(sp.id, target.id)) fail(409, '이미 Crew다');
  db().members.push({ spaceId: sp.id, userId: target.id, role: b.role as SpaceMemberRole, createdAt: nowIso() });
  audit('space.member.add', u.id, 'space', sp.id, { userId: target.id, role: b.role });
  return { ok: true };
});
on('PATCH', `/api/spaces/:id/members/${ID}`, (r, [id, userId]) => {
  const u = me();
  const sp = manageCrew(id, u);
  const m = db().members.find((x) => x.spaceId === sp.id && x.userId === userId) ?? fail(404, 'Crew가 아니다');
  const role = (r.body as { role?: string })?.role ?? '';
  if (!(ASSIGNABLE_MEMBER_ROLES as readonly string[]).includes(role) || m.role === 'owner') fail(400, '주인의 자리는 바꾸지 않는다');
  const from = m.role;
  m.role = role as SpaceMemberRole;
  audit('space.member.role.change', u.id, 'space', sp.id, { userId, from, to: role });
  return { ok: true };
});
on('DELETE', `/api/spaces/:id/members/${ID}`, (_r, [id, userId]) => {
  const u = me();
  const sp = manageCrew(id, u);
  const m = db().members.find((x) => x.spaceId === sp.id && x.userId === userId) ?? fail(404, 'Crew가 아니다');
  if (m.role === 'owner') fail(400, '하나뿐인 주인은 뺄 수 없다');
  db().members = db().members.filter((x) => x !== m);
  audit('space.member.remove', u.id, 'space', sp.id, { userId });
  return { ok: true };
});

// 분류 (P15)
on('GET', '/api/categories', () => {
  const u = me();
  return [...db().categories].sort(byName).map((c) => categoryView(c, u));
});
on('POST', '/api/categories', (r) => {
  const u = me();
  const name = String((r.body as { name?: unknown })?.name ?? '').trim();
  if (!name) fail(400, '이름을 적는다');
  if (db().categories.some((c) => c.name === name)) fail(409, '같은 이름의 분류가 있다');
  const c = { id: newId(), name, createdBy: u.id, createdAt: nowIso() };
  db().categories.push(c);
  audit('category.create', u.id, 'category', c.id, { name });
  return categoryView(c, u);
});
on('PATCH', '/api/categories/:id', (r, [id]) => {
  const u = me();
  const c = db().categories.find((x) => x.id === id) ?? fail(404, '분류가 없다');
  if (!categoryView(c, u).access.canRename) fail(403, '이 분류를 바꿀 수 없다');
  const name = String((r.body as { name?: unknown })?.name ?? '').trim();
  if (!name) fail(400, '이름을 적는다');
  c.name = name;
  audit('category.update', u.id, 'category', c.id, { name });
  return categoryView(c, u);
});
on('DELETE', '/api/categories/:id', (_r, [id]) => {
  const u = me();
  const c = db().categories.find((x) => x.id === id) ?? fail(404, '분류가 없다');
  if (!categoryView(c, u).access.canDelete) fail(403, '이 분류를 지울 수 없다');
  for (const s of db().spaces) if (s.categoryId === id) s.categoryId = null;
  db().categories = db().categories.filter((x) => x !== c);
  audit('category.delete', u.id, 'category', id, { name: c.name });
  return { ok: true };
});

// 페이지 (P2·P6·P14)
on('GET', '/api/pages', (r) => {
  const u = me();
  const spaceId = r.query.get('spaceId') ?? '';
  readableSpace(spaceId, u);
  return livePages(spaceId)
    .sort((a, b) => a.position - b.position)
    .map(pageSummary);
});
on('GET', '/api/pages/:id', (_r, [id]) => pageView(readablePage(id, me())));
on('POST', '/api/pages', (r) => {
  const u = me();
  const dto = parse(createPageDto, r.body);
  writableSpace(dto.spaceId, u);
  if (dto.parentId) {
    const parent = db().pages.find((p) => p.id === dto.parentId && !p.deletedAt && p.spaceId === dto.spaceId);
    if (!parent) fail(404, '페이지를 찾을 수 없다');
  }
  const t = nowIso();
  const p: DemoPage = {
    id: newId(),
    spaceId: dto.spaceId,
    parentId: dto.parentId,
    position: nextPosition(dto.spaceId, dto.parentId),
    createdBy: u.id,
    createdAt: t,
    updatedAt: t,
    deletedAt: null,
    deletedBy: null,
    versions: [{ no: 1, title: dto.title, content: stampSchemaVersion(dto.content as DocNode), createdBy: u.id, createdAt: t }],
  };
  db().pages.push(p);
  audit('page.create', u.id, 'page', p.id, { spaceId: dto.spaceId, title: dto.title });
  notifyMentions(dto.content as DocNode, null, p, u, null);
  return pageView(p);
});
on('PATCH', '/api/pages/:id', (r, [id]) => {
  const u = me();
  const p = writablePage(id, u);
  const dto = parse(updatePageDto, r.body);
  const cur = head(p);
  if (dto.baseVersionNo !== cur.no) fail(409, '다른 사람이 먼저 저장했다 — 새로 불러와 다시 고친다');
  const t = nowIso();
  p.versions.push({ no: cur.no + 1, title: dto.title, content: stampSchemaVersion(dto.content as DocNode), createdBy: u.id, createdAt: t });
  p.updatedAt = t;
  audit('page.update', u.id, 'page', p.id, { versionNo: cur.no + 1 });
  notifyMentions(dto.content as DocNode, cur.content, p, u, null);
  return pageView(p);
});
on('PATCH', '/api/pages/:id/move', (r, [id]) => {
  const u = me();
  const p = writablePage(id, u);
  const dto = parse(movePageDto, r.body);
  if (dto.parentId) {
    let cur: string | null = dto.parentId;
    while (cur) {
      if (cur === p.id) fail(400, '자기 아래로는 옮길 수 없다');
      const parent: DemoPage | undefined = db().pages.find((x) => x.id === cur && !x.deletedAt && x.spaceId === p.spaceId);
      if (!parent) fail(404, '페이지를 찾을 수 없다');
      cur = parent!.parentId;
    }
  }
  const from = { parentId: p.parentId, position: siblings(p.spaceId, p.parentId).findIndex((x) => x.id === p.id) };
  const sib = siblings(p.spaceId, dto.parentId, p.id);
  const at = Math.min(dto.position, sib.length);
  sib.splice(at, 0, p);
  sib.forEach((x, i) => (x.position = (i + 1) * 1024));
  p.parentId = dto.parentId;
  p.updatedAt = nowIso();
  audit('page.move', u.id, 'page', p.id, { from, to: { parentId: dto.parentId, position: at } });
  return pageSummary(p);
});
on('DELETE', '/api/pages/:id', (_r, [id]) => {
  const u = me();
  const p = writablePage(id, u);
  const t = nowIso();
  // 아래 페이지도 함께 휴지통으로 — 서버와 같다
  const drop = (pid: string) => {
    for (const c of livePages(p.spaceId).filter((x) => x.parentId === pid)) drop(c.id);
    const x = db().pages.find((y) => y.id === pid)!;
    x.deletedAt = t;
    x.deletedBy = u.id;
  };
  drop(p.id);
  audit('page.delete', u.id, 'page', p.id, { title: head(p).title });
  return { ok: true };
});
on('GET', '/api/pages/:id/versions', (_r, [id]) => {
  const p = readablePage(id, me());
  return [...p.versions].reverse().map(
    (v): PageVersionView => ({ versionNo: v.no, title: v.title, createdBy: v.createdBy, createdByName: userName(v.createdBy) ?? '', createdAt: v.createdAt }),
  );
});
on('GET', '/api/pages/:id/versions/(\\d+)', (_r, [id, no]) => {
  const p = readablePage(id, me());
  const v = p.versions.find((x) => x.no === Number(no)) ?? fail(404, '그 버전이 없다');
  return { versionNo: v.no, title: v.title, createdBy: v.createdBy, createdByName: userName(v.createdBy) ?? '', createdAt: v.createdAt, content: v.content };
});
on('GET', '/api/pages/:id/versions/(\\d+)/diff/(\\d+)', (_r, [id, a, b]): PageDiffView => {
  const p = readablePage(id, me());
  const va = p.versions.find((x) => x.no === Number(a)) ?? fail(404, '그 버전이 없다');
  const vb = p.versions.find((x) => x.no === Number(b)) ?? fail(404, '그 버전이 없다');
  const side = (v: typeof va) => ({ versionNo: v.no, title: v.title, createdByName: userName(v.createdBy) ?? '', createdAt: v.createdAt });
  return { from: side(va), to: side(vb), titleChanged: va.title !== vb.title, diff: diffDocs(va.content, vb.content) };
});
on('POST', '/api/pages/:id/versions/(\\d+)/restore', (_r, [id, no]) => {
  const u = me();
  const p = writablePage(id, u);
  const v = p.versions.find((x) => x.no === Number(no)) ?? fail(404, '그 버전이 없다');
  const t = nowIso();
  const next = head(p).no + 1;
  p.versions.push({ no: next, title: v.title, content: v.content, createdBy: u.id, createdAt: t });
  p.updatedAt = t;
  audit('page.version.restore', u.id, 'page', p.id, { from: v.no, to: next });
  return pageView(p);
});

// 검색·라벨 (P3·P4)
on('GET', '/api/search', (r) => {
  const u = me();
  const q = (r.query.get('q') ?? '').trim();
  if (!q) return fail(400, '찾을 말을 적는다');
  const spaceId = r.query.get('spaceId');
  const limit = Math.min(Number(r.query.get('limit') ?? 20) || 20, 50);
  const ql = q.toLowerCase();
  const found = db().pages.filter(
    (p) => (!spaceId || p.spaceId === spaceId) && (head(p).title.toLowerCase().includes(ql) || extractText(head(p).content).toLowerCase().includes(ql)),
  );
  return hitsOf(found, u, q, limit);
});
const labelsOf = (pageId: string): LabelView[] =>
  db()
    .pageLabels.filter((x) => x.pageId === pageId)
    .map((x) => db().labels.find((l) => l.id === x.labelId)!)
    .sort(byName);
on('GET', '/api/labels', () => {
  me();
  return [...db().labels].sort(byName);
});
on('GET', '/api/labels/([^/]+)/pages', (r, [raw]) => {
  const u = me();
  const name = decodeURIComponent(raw);
  const l = db().labels.find((x) => x.name === name);
  if (!l) return [];
  const ids = new Set(db().pageLabels.filter((x) => x.labelId === l.id).map((x) => x.pageId));
  return hitsOf(
    db().pages.filter((p) => ids.has(p.id)),
    u,
    '',
    Number(r.query.get('limit') ?? 200) || 200,
  );
});
on('GET', '/api/pages/:id/labels', (_r, [id]) => {
  readablePage(id, me());
  return labelsOf(id);
});
on('POST', '/api/pages/:id/labels', (r, [id]) => {
  const u = me();
  writablePage(id, u);
  const { name } = parse(attachLabelDto, r.body);
  let l = db().labels.find((x) => x.name === name);
  if (!l) db().labels.push((l = { id: newId(), name }));
  if (!db().pageLabels.some((x) => x.pageId === id && x.labelId === l!.id)) db().pageLabels.push({ pageId: id, labelId: l.id });
  audit('label.attach', u.id, 'page', id, { label: name });
  return l;
});
on('DELETE', `/api/pages/:id/labels/${ID}`, (_r, [id, labelId]) => {
  const u = me();
  writablePage(id, u);
  const l = db().labels.find((x) => x.id === labelId);
  db().pageLabels = db().pageLabels.filter((x) => !(x.pageId === id && x.labelId === labelId));
  audit('label.detach', u.id, 'page', id, { label: l?.name ?? null });
  return { ok: true };
});

// 댓글 (P3)
function commentView(c: DemoState['comments'][number], u: DemoUser): CommentView {
  const p = db().pages.find((x) => x.id === c.pageId)!;
  const sp = db().spaces.find((x) => x.id === p.spaceId)!;
  const a = accessOf(sp, u);
  // 서버와 같다 — 쓴 사람, 또는 그 공간에 쓰고 지울 수 있는 사람
  return { ...c, createdByName: userName(c.createdBy) ?? '', canDelete: c.createdBy === u.id || (a.canWrite && can(principal(u), 'page.delete')) };
}
on('GET', '/api/pages/:id/comments', (_r, [id]) => {
  const u = me();
  readablePage(id, u);
  return db()
    .comments.filter((c) => c.pageId === id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((c) => commentView(c, u));
});
on('POST', '/api/pages/:id/comments', (r, [id]) => {
  const u = me();
  // 댓글은 그 공간에 쓸 수 있는 사람이 단다(서버와 같다) — 읽기만 되는 공간에서는 댓글 칸도 없다
  const p = writablePage(id, u);
  const dto = parse(createCommentDto, r.body);
  const t = nowIso();
  const c = { id: newId(), pageId: id, parentId: dto.parentId ?? null, body: dto.body as DocNode, createdBy: u.id, createdAt: t, updatedAt: t };
  db().comments.push(c);
  audit('comment.create', u.id, 'comment', c.id, { pageId: id });
  notifyMentions(c.body, null, p, u, c.id);
  return commentView(c, u);
});
on('DELETE', '/api/comments/:id', (_r, [id]) => {
  const u = me();
  const c = db().comments.find((x) => x.id === id) ?? fail(404, '댓글이 없다');
  writablePage(c.pageId, u);
  if (!commentView(c, u).canDelete) fail(403, '이 댓글을 지울 수 없다');
  db().comments = db().comments.filter((x) => x.id !== id && x.parentId !== id);
  audit('comment.delete', u.id, 'comment', id, { pageId: c.pageId });
  return { ok: true };
});

// 첨부 — 목록만 (올리기·받기는 시연판에 없다)
on('GET', '/api/pages/:id/attachments', (_r, [id]) => {
  readablePage(id, me());
  return db()
    .attachments.filter((a) => a.pageId === id)
    .map((a): AttachmentView => ({ ...a, uploadedByName: userName(a.uploadedBy) ?? '' }));
});
on('POST', '/api/pages/:id/attachments', () => fail(400, NOT_IN_DEMO));
on('DELETE', '/api/attachments/:id', () => fail(400, NOT_IN_DEMO));

// 알림 (P4·P8)
function notificationView(n: DemoState['notifications'][number]): NotificationView {
  const p = n.pageId ? db().pages.find((x) => x.id === n.pageId && !x.deletedAt) : undefined;
  return {
    id: n.id,
    kind: n.kind,
    pageId: p ? p.id : null,
    commentId: n.commentId,
    actorName: userName(n.actorId),
    actorUsername: null,
    pageTitle: p ? head(p).title : null,
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}
const myNotifications = (u: DemoUser) => db().notifications.filter((n) => n.userId === u.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
on('GET', '/api/notifications', (r) => myNotifications(me()).slice(0, Number(r.query.get('limit') ?? 50) || 50).map(notificationView));
on('GET', '/api/notifications/unread-count', () => ({ count: myNotifications(me()).filter((n) => !n.readAt).length }));
on('POST', '/api/notifications/:id/read', (_r, [id]) => {
  const n = myNotifications(me()).find((x) => x.id === id) ?? fail(404, '알림이 없다');
  n.readAt ??= nowIso();
  return { ok: true };
});
on('POST', '/api/notifications/read-all', () => {
  for (const n of myNotifications(me())) n.readAt ??= nowIso();
  return { ok: true };
});

// 템플릿 (P6)
const templateView = (t: DemoState['templates'][number]): PageTemplateView => ({ ...t });
on('GET', '/api/templates', () => {
  me();
  return [...db().templates].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map(templateView);
});
on('POST', '/api/templates', (r) => {
  const u = me();
  const dto = parse(createTemplateDto, r.body);
  if (db().templates.some((t) => t.name === dto.name)) fail(409, '같은 이름의 템플릿이 있다');
  const t = { id: newId(), name: dto.name, description: dto.description ?? null, content: dto.content as DocNode, updatedAt: nowIso() };
  db().templates.push(t);
  audit('template.create', u.id, 'template', t.id, { name: t.name });
  return templateView(t);
});
on('DELETE', '/api/templates/:id', (_r, [id]) => {
  const u = me();
  const t = db().templates.find((x) => x.id === id) ?? fail(404, '템플릿이 없다');
  db().templates = db().templates.filter((x) => x !== t);
  audit('template.delete', u.id, 'template', id, { name: t.name });
  return { ok: true };
});

// 휴지통 (P2·P4)
on('GET', '/api/trash/pages', () => {
  const u = me();
  return db()
    .pages.filter((p) => p.deletedAt && canReadSpaceId(p.spaceId, u) && accessOf(db().spaces.find((s) => s.id === p.spaceId)!, u).canWrite)
    .sort((a, b) => (a.deletedAt! < b.deletedAt! ? 1 : -1))
    .map((p): TrashPageView => ({
      id: p.id,
      title: head(p).title,
      spaceId: p.spaceId,
      spaceName: db().spaces.find((s) => s.id === p.spaceId)!.name,
      deletedAt: p.deletedAt!,
      deletedByName: userName(p.deletedBy) ?? '(알 수 없음)',
    }));
});
on('POST', '/api/trash/pages/:id/restore', (_r, [id]) => {
  const u = me();
  const p = db().pages.find((x) => x.id === id && x.deletedAt) ?? fail(404, '휴지통에 그 페이지가 없다');
  writableSpace(p.spaceId, u);
  const parentAlive = !p.parentId || db().pages.some((x) => x.id === p.parentId && !x.deletedAt);
  p.deletedAt = null;
  p.deletedBy = null;
  if (!parentAlive) {
    p.parentId = null;
    p.position = nextPosition(p.spaceId, null);
  }
  audit('page.restore.trash', u.id, 'page', p.id, { title: head(p).title });
  return { movedToRoot: !parentAlive };
});
on('GET', '/api/trash/spaces', () => {
  const u = me();
  return db()
    .spaces.filter((s) => s.deletedAt && (s.createdBy === u.id || can(principal(u), 'space.oversee')))
    .map((s): TrashSpaceView => ({ id: s.id, key: s.key, name: s.name, deletedAt: s.deletedAt!, createdByName: userName(s.createdBy) ?? '' }));
});
on('POST', '/api/trash/spaces/:id/restore', (_r, [id]) => {
  const u = me();
  const s = db().spaces.find((x) => x.id === id && x.deletedAt) ?? fail(404, '휴지통에 그 스페이스가 없다');
  if (s.createdBy !== u.id && !can(principal(u), 'space.oversee')) fail(403, '되살릴 권한이 없다');
  s.deletedAt = null;
  audit('space.restore', u.id, 'space', s.id, { name: s.name });
  return { ok: true };
});

// 감사로그 (P1·P4·P17) — 관리자만
on('GET', '/api/audit', (r) => {
  const u = me();
  if (!can(principal(u), 'audit.read')) fail(403, '감사로그를 볼 권한이 없다');
  const action = r.query.get('action');
  const from = r.query.get('from');
  const to = r.query.get('to');
  const limit = Math.min(Number(r.query.get('limit') ?? 200) || 200, 500);
  return [...db().audit]
    .reverse()
    .filter((e) => (!action || e.action === action) && (!from || e.createdAt >= from) && (!to || e.createdAt < to))
    .slice(0, limit)
    .map((e): AuditEventView => ({ ...e, actorName: userName(e.actorId), ip: '시연판(폰 안)', requestId: null }));
});

// 운영 설정·사용자 — 보기만
on('GET', '/api/settings/policy', () => {
  const u = me();
  const p = db().policy;
  if (can(principal(u), 'settings.manage')) return { ...p, uploadCeilingMb: p.uploadMaxMb };
  return { uploadMaxMb: p.uploadMaxMb, allowedExtensions: p.allowedExtensions, passwordMinLength: p.passwordMinLength, passwordMinCharClasses: p.passwordMinCharClasses, uploadCeilingMb: p.uploadMaxMb };
});
on('PATCH', '/api/settings/policy', () => fail(400, NOT_IN_DEMO));
on('GET', '/api/users', (r) => {
  const u = me();
  if (!can(principal(u), 'user.manage')) fail(403, '사용자 관리 권한이 없다');
  const q = r.query.get('q')?.trim().toLowerCase();
  const items = db()
    .users.filter((x) => !q || x.username.includes(q) || x.displayName.toLowerCase().includes(q))
    .map(userView);
  return { items, total: items.length };
});
on('(POST|PUT|PATCH)', `/api/users/${ID}/[a-z-]+`, () => fail(400, NOT_IN_DEMO));

// 사내 LLM — 폰 안에는 없다. 빈 목록으로 답해 화면이 "등록된 LLM이 없다"를 보인다
on('GET', '/api/llm/providers', () => []);
on('GET', '/api/llm/prompts', () => []);
on('GET', '/api/llm/conversations', () => ({ items: [], limits: { retentionDays: POLICY_DEFAULTS.llmRetentionDays, conversationMax: POLICY_DEFAULTS.llmConversationMax, pinnedMax: POLICY_DEFAULTS.llmPinnedMax } }));
on('GET', '/api/llm/admin/providers', () => []);

/** 같은 상태를 화면에 내주지 않는다 — 화면이 받은 것을 고쳐도 저장소가 바뀌지 않게 복사한다 */
const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** `api()`가 부른다 — 서버와 같은 모양으로 답하거나 같은 모양의 `ApiError`를 던진다 */
export async function demoApi<T>(path: string, init: ApiInit = {}): Promise<T> {
  const url = new URL(path, 'https://demo.invalid');
  const method = (init.method ?? 'GET').toUpperCase();
  const body = init.json;
  for (const [m, re, h] of routes) {
    const hit = re.exec(url.pathname);
    if (!hit || !new RegExp(`^(?:${m})$`).test(method)) continue;
    const out = h({ method, path: url.pathname, query: url.searchParams, body }, hit.slice(1));
    if (method !== 'GET') saveState(db());
    return copy(out) as T;
  }
  return fail(404, NOT_IN_DEMO);
}
