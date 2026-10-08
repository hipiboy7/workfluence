import { z } from 'zod';
import { ASSIGNABLE_MEMBER_ROLES, CATEGORY_NAME_MAX, LIST_SEARCH_MAX, MARKDOWN_LIMITS, SPACE_STATUSES } from './constants';
import { extractText, validateDocument, type DocNode } from './document';
import { renderDocMarkdown } from './markdown';
import { parseMarkdown } from './markdown-parse';
import { attachLabelDto, idSchema, usernameSchema, type AttachmentView, type CategoryView, type CommentView, type LabelView, type PageTemplateView, type SpaceMemberView, type SpaceStatusDto, type SpaceView } from './schemas';

/**
 * 공개 API v1의 계약 중 순수한 부분 (A등급, docs/spinoff/public-api 설계서 3.3·3.5절 · FR-2211·2215·2223~2225).
 *
 * **에이전트용 단순 계약**(사용자 지시 2026-10-07): 에이전트가 정하는 것은 어디(스페이스)·제목·본문뿐이고 나머지는 서버가 기본값으로 채운다.
 * 그 기본값은 이 파일의 `V1_DEFAULTS` **한 곳**에 있고, OpenAPI의 `default`와 사용가이드가 거기서 나온다.
 */

/** v1 경로의 접두사 — 응답이 싣는 주소와 컨트롤러가 같은 값을 본다 */
export const V1_BASE_PATH = '/api/v1';

export const V1_DEFAULTS = {
  /** 쓸 때 본문의 형식 — 에이전트는 마크다운을 쓴다 */
  writeFormat: 'markdown',
  /** 읽을 때 본문의 형식 — 마크다운이 JSON 트리보다 훨씬 짧아 에이전트의 문맥을 덜 쓴다 */
  readFormat: 'markdown',
  /** 이름으로 스페이스를 고를 때 팀·개인 각각 훑는 수 — 볼 수 있는 스페이스 수보다 넉넉하다 */
  spaceLookupMax: 5000,
  /** 목록·트리의 상한 */
  listLimit: 200,
  /** 목록 상한으로 줄 수 있는 가장 큰 값 */
  listLimitMax: 1000,
  /** 에이전트가 만드는 스페이스의 종류 — 팀뿐이다. 개인 스페이스는 계정과 함께 생긴다 */
  spaceKind: 'team',
  /** Crew에 넣을 때 역할을 안 주면 — 에이전트가 사람을 넣는 까닭은 같이 쓰기 위해서다 */
  memberRole: 'editor',
  /** 검색 결과의 기본 개수와 상한 — 화면용 검색(`searchQueryDto`)과 같다 */
  searchLimit: 20,
  searchLimitMax: 50,
  /** 첨부를 JSON으로 올릴 때 내용의 인코딩 — 글이면 utf8, 바이너리면 base64 */
  uploadEncoding: 'utf8',
  /** 첨부를 JSON(`format=json`)으로 받을 수 있는 가장 큰 크기 — 그 위는 바이너리로 받는다. 응답 한 번이 이만큼의 문맥을 먹는다 */
  attachmentJsonMaxBytes: 1_000_000,
  /** 옮길 때 위치를 안 주면 — 형제 수보다 큰 값은 맨 끝이다(`movePageDto`) */
  moveToEnd: 1_000_000,
} as const;

export const V1_WRITE_FORMATS = ['markdown', 'json'] as const;
export const V1_READ_FORMATS = ['markdown', 'json', 'text'] as const;
export type V1WriteFormat = (typeof V1_WRITE_FORMATS)[number];
export type V1ReadFormat = (typeof V1_READ_FORMATS)[number];

// ---- 본문 형식 ----

export type BodyResult = { ok: true; doc: DocNode } | { ok: false; errors: string[] };

/** 받은 본문을 문서로 — 마크다운은 변환하고 JSON은 정본 검증으로 거른다. 어긋나면 고치지 않고 까닭을 말한다 */
export function bodyToDoc(format: V1WriteFormat, body: unknown): BodyResult {
  if (format === 'markdown') {
    if (typeof body !== 'string') return { ok: false, errors: ['본문(body)은 글자(마크다운)여야 한다'] };
    return parseMarkdown(body);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, errors: ['format이 json이면 본문(body)은 문서 객체여야 한다'] };
  const v = validateDocument(body);
  return v.ok ? { ok: true, doc: body as DocNode } : { ok: false, errors: v.errors };
}

/** 문서를 읽을 형식으로 */
export function docToBody(format: V1ReadFormat, doc: DocNode): string | DocNode {
  if (format === 'json') return doc;
  return format === 'markdown' ? renderDocMarkdown(doc) : extractText(doc);
}

// ---- 입력 ----

const spaceRef = z.string().trim().min(1).max(200).describe('스페이스의 이름이나 id');
const titleSchema = z.string().trim().min(1).max(300).describe('페이지의 제목 — 300자까지');
const bodyField = z.unknown().refine((v) => v !== undefined, { message: '본문(body)이 필요하다' }).describe('본문 — format이 markdown(기본)이면 마크다운 글자, json이면 문서 객체');
/** 쓰기 본문의 형식 — 칸마다 같은 설명이 붙게 한 곳에 둔다 */
const writeFormat = z.enum(V1_WRITE_FORMATS).default(V1_DEFAULTS.writeFormat).describe('body의 형식 — markdown(기본) 또는 json(문서 객체)');

/** 변환 결과를 입력의 `body` 칸 오류로 */
function convert(format: V1WriteFormat, body: unknown, ctx: z.RefinementCtx): DocNode {
  const r = bodyToDoc(format, body);
  if (r.ok) return r.doc;
  for (const message of r.errors) ctx.addIssue({ code: 'custom', message, path: ['body'] });
  return z.NEVER;
}

/** 페이지 만들기 — 필수는 `space`(id나 이름)·`title`·`body`. 부모는 없으면 맨 위, 위치는 맨 끝 */
export const v1CreatePageDto = z
  .strictObject({
    space: spaceRef,
    title: titleSchema,
    body: bodyField,
    format: writeFormat,
    parentId: idSchema.nullable().default(null).describe('부모 페이지의 id — 안 주면 스페이스의 맨 위'),
  })
  .transform((v, ctx) => ({ space: v.space, title: v.title, parentId: v.parentId, doc: convert(v.format, v.body, ctx) }));
export type V1CreatePageDto = z.infer<typeof v1CreatePageDto>;

/** 페이지 고치기 — 고칠 것만. 기준 버전을 안 주면 서버가 지금 버전을 쓴다(편집 중이면 409 — 설계서 FR-2216) */
export const v1UpdatePageDto = z
  .strictObject({
    title: titleSchema.optional(),
    body: z.unknown().optional(),
    format: writeFormat,
    baseVersionNo: z.number().int().positive().optional().describe('고치는 기준이 되는 버전 번호 — 안 주면 지금 버전. 그 사이 다른 사람이 저장했으면 409 VERSION_CONFLICT'),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined, { message: '고칠 것이 없다 — title이나 body 중 하나는 있어야 한다' })
  .transform((v, ctx) => ({
    title: v.title,
    doc: v.body === undefined ? undefined : convert(v.format, v.body, ctx),
    baseVersionNo: v.baseVersionNo,
  }));
export type V1UpdatePageDto = z.infer<typeof v1UpdatePageDto>;

/** 옮기기 — 부모만 있으면 된다(`null`은 맨 위). 위치를 안 주면 맨 끝 */
export const v1MovePageDto = z.strictObject({
  parentId: idSchema.nullable(),
  position: z.number().int().min(0).default(V1_DEFAULTS.moveToEnd),
});
export type V1MovePageDto = z.infer<typeof v1MovePageDto>;

/** 읽기의 형식 — 없으면 마크다운 */
export const v1PageQuery = z.object({ format: z.enum(V1_READ_FORMATS).default(V1_DEFAULTS.readFormat) });
export type V1PageQuery = z.infer<typeof v1PageQuery>;

// ---- 응답 ----

export type V1Ancestor = { id: string; title: string };
/** 페이지 하나 — 본문은 `format`대로(기본 마크다운), 서버가 채운 부모·위치·버전과 조상 경로가 함께 온다 (FR-2217·2225) */
export type V1PageView = {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  position: number;
  currentVersionNo: number;
  updatedAt: string;
  createdAt: string;
  format: V1ReadFormat;
  body: string | DocNode;
  ancestors: V1Ancestor[];
};
export type V1VersionView = { versionNo: number; title: string; createdByName: string; createdAt: string; format: V1ReadFormat; body: string | DocNode };

// ---- 템플릿 ----

const templateName = z.string().trim().min(1).max(80);
const templateDescription = z.string().trim().max(200).nullable();

/** 템플릿 만들기 — 필수는 이름과 본문이다(관리자만 — 화면용과 같다). 설명은 선택 */
export const v1TemplateDto = z
  .strictObject({ name: templateName, body: bodyField, format: writeFormat, description: templateDescription.optional() })
  .transform((v, ctx) => ({ name: v.name, description: v.description, content: convert(v.format, v.body, ctx) }));
export type V1TemplateDto = z.infer<typeof v1TemplateDto>;

/** 템플릿 고치기 — 고칠 것만(있는 칸만 결과에 담긴다). 설명은 `null`이면 지운다 */
export const v1TemplateUpdateDto = z
  .strictObject({ name: templateName.optional(), body: z.unknown().optional(), format: writeFormat, description: templateDescription.optional() })
  .refine((v) => v.name !== undefined || v.body !== undefined || v.description !== undefined, { message: '고칠 것이 없다 — name·body·description 중 하나는 있어야 한다' })
  .transform((v, ctx) => ({
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
    ...(v.body !== undefined ? { content: convert(v.format, v.body, ctx) } : {}),
  }));
export type V1TemplateUpdateDto = z.infer<typeof v1TemplateUpdateDto>;

export type V1TemplateView = { id: string; name: string; description: string | null; updatedAt: string; format: V1ReadFormat; body: string | DocNode };
export const toV1Template = (t: PageTemplateView, format: V1ReadFormat): V1TemplateView => ({
  id: t.id,
  name: t.name,
  description: t.description,
  updatedAt: t.updatedAt,
  format,
  body: docToBody(format, t.content),
});

// ---- 검색 ----

/** 검색 — 필수는 검색어뿐이다. 스페이스는 이름이나 id로 좁힌다(없으면 읽을 수 있는 전부). 쿼리의 모르는 칸도 거절한다 */
/** 페이지 트리의 쿼리 — 범위 밖의 `limit`·모르는 칸은 400 */
export const v1PageTreeQuery = z.strictObject({
  space: z.string().describe('스페이스의 이름이나 id'),
  limit: z.coerce.number().int().min(1).max(V1_DEFAULTS.listLimitMax).default(V1_DEFAULTS.listLimit).describe('돌려줄 가장 많은 수'),
});
export type V1PageTreeQuery = z.infer<typeof v1PageTreeQuery>;

export const v1SearchQuery = z.strictObject({
  q: z.string().trim().min(1).max(200).describe('검색어 — 제목과 본문에서 찾는다(두 글자부터 된다)'),
  space: spaceRef.optional(),
  limit: z.coerce.number().int().min(1).max(V1_DEFAULTS.searchLimitMax).default(V1_DEFAULTS.searchLimit),
});
export type V1SearchQuery = z.infer<typeof v1SearchQuery>;

// ---- 댓글·라벨·첨부 ----

/** 댓글 쓰기 — 필수는 본문뿐이다. 답글이면 `parentId` */
export const v1CommentDto = z
  .strictObject({ body: bodyField, format: writeFormat, parentId: idSchema.nullable().default(null) })
  .transform((v, ctx) => ({ parentId: v.parentId, doc: convert(v.format, v.body, ctx) }));
export type V1CommentDto = z.infer<typeof v1CommentDto>;

export const v1CommentUpdateDto = z
  .strictObject({ body: bodyField, format: writeFormat })
  .transform((v, ctx) => ({ doc: convert(v.format, v.body, ctx) }));
export type V1CommentUpdateDto = z.infer<typeof v1CommentUpdateDto>;

/** 라벨 붙이기 — 이름만 */
export const v1LabelDto = z.strictObject({ name: attachLabelDto.shape.name });
export type V1LabelDto = z.infer<typeof v1LabelDto>;

/** 라벨을 이름이나 id로 고른다 — 떼는 쪽이 id를 찾지 않게. 라벨 이름은 소문자로 저장된다 */
export function matchLabel<T extends { id: string; name: string }>(ref: string, labels: readonly T[]): T | null {
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return null;
  return labels.find((l) => l.id.toLowerCase() === wanted || l.name.toLowerCase() === wanted) ?? null;
}

const BASE64 = /^[A-Za-z0-9+/\r\n]*={0,2}$/;

/**
 * 첨부를 JSON으로 올린다 — 에이전트는 바이너리를 보낼 수 없다. 이름과 내용이면 된다(글은 utf8, 바이너리는 base64). **형식(mime)은 받지 않는다** — 올리는
 * 쪽이 말한 형식을 쓰지 않고 확장자에서 정한다(`canonicalMime`). 종류·크기·내용 검사는 화면용 업로드와 같다
 */
export const v1UploadDto = z
  .strictObject({
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((v) => !/[\\/]/.test(v) && v !== '.' && v !== '..', '파일 이름에 경로를 쓸 수 없다'),
    content: z.string().min(1, '내용이 비어 있다'),
    encoding: z.enum(['utf8', 'base64']).default(V1_DEFAULTS.uploadEncoding),
  })
  .superRefine((v, ctx) => {
    if (v.encoding === 'base64' && !BASE64.test(v.content)) ctx.addIssue({ code: 'custom', message: 'base64가 아니다', path: ['content'] });
  });
export type V1UploadDto = z.infer<typeof v1UploadDto>;

/** 첨부 받기 — `format=json`이면 글은 utf8, 바이너리는 base64로 JSON에 담는다 */
export const v1DownloadQuery = z.object({ format: z.enum(['json']).optional() });
export type V1DownloadQuery = z.infer<typeof v1DownloadQuery>;

export type V1CommentView = {
  id: string;
  pageId: string;
  parentId: string | null;
  author: string;
  createdAt: string;
  updatedAt: string;
  canDelete: boolean;
  format: V1ReadFormat;
  body: string | DocNode;
};
export type V1AttachmentView = {
  id: string;
  pageId: string;
  filename: string;
  mime: string;
  size: number;
  uploadedByName: string;
  createdAt: string;
  /** 이 API로 받는 주소 */
  url: string;
  /** 위키 안의 주소 — 본문에 `[이름](주소)`로 넣으면 사람이 눌러 받는다. 문서에는 그림 노드가 없어 링크로 건다 */
  href: string;
};
export type V1AttachmentJson = { id: string; filename: string; mime: string; size: number; encoding: 'utf8' | 'base64'; content: string };

export const toV1Comment = (c: CommentView, format: V1ReadFormat): V1CommentView => ({
  id: c.id,
  pageId: c.pageId,
  parentId: c.parentId,
  author: c.createdByName,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  canDelete: c.canDelete,
  format,
  body: docToBody(format, c.body),
});
export const toV1Attachment = (a: AttachmentView): V1AttachmentView => ({
  id: a.id,
  pageId: a.pageId,
  filename: a.filename,
  mime: a.mime,
  size: a.size,
  uploadedByName: a.uploadedByName,
  createdAt: a.createdAt,
  url: `${V1_BASE_PATH}/attachments/${a.id}`,
  href: `/api/attachments/${a.id}`,
});
export type V1LabelView = LabelView;

// ---- 스페이스·Crew·분류 ----

const spaceName = z.string().trim().min(1).max(200);
const spaceDescription = z.string().trim().max(2000);
/** 분류는 **이름으로** 고른다 — id를 외우지 않게 */
const categoryRef = z.string().trim().min(1).max(CATEGORY_NAME_MAX);

/** 스페이스 만들기 — 필수는 이름뿐이다. 종류는 팀, 설명은 빈 글, 분류는 없음 */
export const v1CreateSpaceDto = z.strictObject({
  name: spaceName,
  description: spaceDescription.default(''),
  category: categoryRef.nullable().default(null),
});
export type V1CreateSpaceDto = z.infer<typeof v1CreateSpaceDto>;

/** 스페이스 고치기 — 고칠 것만. 분류는 `null`이면 지우고, 없으면 그대로 */
export const v1UpdateSpaceDto = z
  .strictObject({ name: spaceName.optional(), description: spaceDescription.optional(), category: categoryRef.nullable().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: '고칠 것이 없다 — name·description·category 중 하나는 있어야 한다' });
export type V1UpdateSpaceDto = z.infer<typeof v1UpdateSpaceDto>;

/** 중지·다시 쓰기. `takeover`는 주인이 건 중지를 관리자가 넘겨받을 때만(중지에만) */
export const v1SpaceStatusDto = z
  .strictObject({ status: z.enum(SPACE_STATUSES), takeover: z.boolean().optional() })
  .transform((v, ctx): SpaceStatusDto => {
    if (v.takeover === true) {
      if (v.status !== 'suspended') {
        ctx.addIssue({ code: 'custom', message: 'takeover는 status가 suspended일 때만 쓴다', path: ['takeover'] });
        return z.NEVER;
      }
      return { status: 'suspended', takeover: true };
    }
    return { status: v.status };
  });
export type V1SpaceStatusDto = z.infer<typeof v1SpaceStatusDto>;

/** Crew에 넣기 — 사용자 이름만 있으면 된다. 역할은 editor(owner 자리는 줄 수 없다) */
export const v1AddMemberDto = z.strictObject({ username: usernameSchema, role: z.enum(ASSIGNABLE_MEMBER_ROLES).default(V1_DEFAULTS.memberRole) });
export type V1AddMemberDto = z.infer<typeof v1AddMemberDto>;

export const v1MemberRoleDto = z.strictObject({ role: z.enum(ASSIGNABLE_MEMBER_ROLES) });
export type V1MemberRoleDto = z.infer<typeof v1MemberRoleDto>;

export const v1CategoryDto = z.strictObject({ name: categoryRef });
export type V1CategoryDto = z.infer<typeof v1CategoryDto>;

/** 스페이스 목록 — 찾기와 상한은 선택이다 */
export const v1SpaceListQuery = z.object({
  q: z
    .string()
    .trim()
    .max(LIST_SEARCH_MAX)
    .optional()
    .transform((v) => (v ? v : undefined)),
  limit: z.coerce.number().int().min(1).max(V1_DEFAULTS.listLimitMax).optional(),
});
export type V1SpaceListQuery = z.infer<typeof v1SpaceListQuery>;

/** Crew를 사용자 이름이나 id로 고른다 — 사용자 이름을 아는 에이전트가 id를 찾지 않게 */
export function matchMember<T extends { userId: string; username: string }>(ref: string, members: readonly T[]): T | null {
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return null;
  return members.find((m) => m.userId.toLowerCase() === wanted || m.username.toLowerCase() === wanted) ?? null;
}

export type V1SpaceView = {
  id: string;
  name: string;
  description: string;
  kind: SpaceView['kind'];
  status: SpaceView['status'];
  category: string | null;
  categoryId: string | null;
  memberCount: number;
  myRole: SpaceView['myRole'];
  canWrite: boolean;
  canManageMembers: boolean;
};
export type V1MemberView = { userId: string; username: string; displayName: string; role: SpaceMemberView['role'] };
export type V1CategoryView = { id: string; name: string; canRename: boolean; canDelete: boolean };

/** 에이전트가 쓸 것만 — 열쇠·만든 사람·세부 권한은 뺀다 (설계서 3.5절) */
export const toV1Space = (v: SpaceView): V1SpaceView => ({
  id: v.id,
  name: v.name,
  description: v.description,
  kind: v.kind,
  status: v.status,
  category: v.categoryName,
  categoryId: v.categoryId,
  memberCount: v.memberCount,
  myRole: v.myRole,
  canWrite: v.access.canWrite,
  canManageMembers: v.access.canManageMembers,
});
export const toV1Member = (m: SpaceMemberView): V1MemberView => ({ userId: m.userId, username: m.username, displayName: m.displayName, role: m.role });
export const toV1Category = (c: CategoryView): V1CategoryView => ({ id: c.id, name: c.name, canRename: c.access.canRename, canDelete: c.access.canDelete });

// ---- 스페이스 고르기 ----

const squash = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * id나 이름으로 스페이스를 고른다 — 에이전트가 uuid를 외우지 않게. **이름이 겹치면 모두 돌려주고** 고르는 것은 부른 쪽이 한다(임의로 고르면
 * 엉뚱한 곳에 쓴다). 정확히 맞는 것이 하나라도 있으면 그것만, 없을 때만 대소문자·빈칸을 무시한다
 */
export function matchSpaces<T extends { id: string; name: string }>(ref: string, spaces: readonly T[]): T[] {
  const wanted = ref.trim();
  if (!wanted) return [];
  const asId = idSchema.safeParse(wanted);
  if (asId.success) return spaces.filter((s) => s.id.toLowerCase() === asId.data);
  const exact = spaces.filter((s) => s.name === wanted);
  if (exact.length) return exact;
  const loose = squash(wanted);
  return spaces.filter((s) => squash(s.name) === loose);
}

// ---- 오류 ----

export type V1ErrorBody = { error: { code: string; message: string; requestId: string | null; details?: unknown } };

const STATUS_CODE: Record<number, string> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE',
};
const STATUS_MESSAGE: Record<number, string> = {
  400: '요청이 올바르지 않다',
  401: '인증이 필요하다',
  403: '권한이 없다',
  404: '찾을 수 없다',
  409: '충돌했다',
  413: '요청이 너무 크다',
  429: '요청이 너무 잦다',
  503: '지금 쓸 수 없다',
};
const MAX_ISSUES = 5;
const MAX_MESSAGE_CHARS = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * v1의 오류는 한 모양이다 — `{ error: { code, message, requestId, details? } }`. 에이전트는 문장이 아니라 `code`로 분기한다. 코드가 없는 오류는 상태에서
 * 정한다(`STATUS_CODE`). 입력 검증 실패는 칸과 까닭을 한 문장에 싣고 **값은 싣지 않는다** — 오류가 로그·감사로 가도 본문이 새지 않게
 */
export function v1ErrorBody(status: number, response: unknown, requestId: string | null): V1ErrorBody {
  const r = isRecord(response) ? response : {};
  let code = typeof r.code === 'string' ? r.code : (STATUS_CODE[status] ?? (status >= 500 ? 'INTERNAL' : 'HTTP_ERROR'));
  let message =
    typeof response === 'string' ? response : typeof r.message === 'string' ? r.message : Array.isArray(r.message) ? r.message.join(' · ') : (STATUS_MESSAGE[status] ?? '서버 오류');
  let details = r.details;

  if (Array.isArray(r.issues) && r.issues.length) {
    const parts = (r.issues as { path?: unknown; message?: unknown }[])
      .slice(0, MAX_ISSUES)
      .map((i) => `${typeof i.path === 'string' && i.path ? i.path : '요청'}: ${String(i.message ?? '')}`);
    const more = r.issues.length > MAX_ISSUES ? ` 외 ${r.issues.length - MAX_ISSUES}건` : '';
    message = `${message} — ${parts.join(' · ')}${more}`;
  }
  if (message.length > MAX_MESSAGE_CHARS) message = `${message.slice(0, MAX_MESSAGE_CHARS)}…`;

  // 기준 버전이 어긋난 저장 — 에이전트가 지금 버전을 알아야 다시 읽고 고칠 수 있다
  if (status === 409 && typeof r.code !== 'string' && typeof r.currentVersionNo === 'number') {
    code = 'VERSION_CONFLICT';
    details = { currentVersionNo: r.currentVersionNo };
  }
  return { error: { code, message, requestId, ...(details !== undefined ? { details } : {}) } };
}

/** 마크다운 변환이 받는 글자 수 — 사용가이드와 명세가 같은 값을 말한다 */
export const V1_BODY_MAX_CHARS = MARKDOWN_LIMITS.maxInputChars;
