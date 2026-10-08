import { z } from 'zod';
import { NOTIFICATION_KINDS, ROLES, SPACE_KINDS, SPACE_MEMBER_ROLES, SPACE_STATUSES, USER_STATUSES } from './constants';
import { DELEGABLE_ACTIONS } from './permissions';
import { V1_READ_FORMATS } from './v1';

/**
 * 공개 API v1의 **응답 모양** (docs/spinoff/public-api 설계서 FR-2221 · 계획서 4.3). A등급 — 순수 선언이다.
 * 명세(`v1-spec.ts`)가 이것을 JSON Schema로 옮기고, api의 계약 시험이 **실제 응답을 이것으로 검증한다** — 응답이 바뀌면 시험이 깨져
 * 명세가 코드와 어긋난 채 남지 못한다. 날짜는 ISO 8601 글자(UTC)다.
 */

const iso = z.string().describe('ISO 8601 시각(UTC)');
const readFormat = z.enum(V1_READ_FORMATS);
/** 문서 한 노드 — 형식(`format=json`)일 때의 본문. 허용 목록 안의 노드만 온다(문서 스키마 버전은 `schemaVersion`) */
const docNode = z.looseObject({ type: z.string() });
/** 본문 — `format`이 markdown·text면 글자, json이면 문서 객체 */
const body = z.union([z.string(), docNode]).describe('format이 json이면 문서 객체, 아니면 글자');

export const v1Ok = z.object({ ok: z.literal(true) });
export const v1Count = z.object({ count: z.number().int() });
export const v1Items = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

// ---- 페이지 ----
export const v1PageSummary = z.object({
  id: z.string(),
  spaceId: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  position: z.number().int(),
  currentVersionNo: z.number().int(),
  updatedAt: iso,
});
export const v1PageTree = z.object({ space: z.object({ id: z.string(), name: z.string() }), items: z.array(v1PageSummary) });
export const v1Page = z.object({
  id: z.string(),
  spaceId: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  position: z.number().int(),
  currentVersionNo: z.number().int(),
  updatedAt: iso,
  createdAt: iso,
  format: readFormat,
  body,
  ancestors: z.array(z.object({ id: z.string(), title: z.string() })).describe('맨 위 페이지부터 부모까지의 경로'),
});
export const v1VersionSummary = z.object({ versionNo: z.number().int(), title: z.string(), createdBy: z.string(), createdByName: z.string(), createdAt: iso });
export const v1Version = z.object({ versionNo: z.number().int(), title: z.string(), createdByName: z.string(), createdAt: iso, format: readFormat, body });
const versionHead = z.object({ versionNo: z.number().int(), title: z.string(), createdByName: z.string(), createdAt: iso });
export const v1Diff = z.object({
  from: versionHead,
  to: versionHead,
  titleChanged: z.boolean(),
  diff: z.object({ changed: z.boolean(), added: z.number().int(), removed: z.number().int(), modified: z.number().int(), blocks: z.array(z.looseObject({})) }),
});
export const v1MovedPage = v1PageSummary;

// ---- 스페이스·Crew·분류 ----
export const v1Space = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(SPACE_KINDS),
  status: z.enum(SPACE_STATUSES),
  category: z.string().nullable(),
  categoryId: z.string().nullable(),
  memberCount: z.number().int(),
  myRole: z.enum(SPACE_MEMBER_ROLES).nullable(),
  canWrite: z.boolean(),
  canManageMembers: z.boolean(),
});
export const v1Member = z.object({ userId: z.string(), username: z.string(), displayName: z.string(), role: z.enum(SPACE_MEMBER_ROLES) });
export const v1Category = z.object({ id: z.string(), name: z.string(), canRename: z.boolean(), canDelete: z.boolean() });

// ---- 댓글·라벨·첨부 ----
export const v1Comment = z.object({
  id: z.string(),
  pageId: z.string(),
  parentId: z.string().nullable(),
  author: z.string(),
  createdAt: iso,
  updatedAt: iso,
  canDelete: z.boolean(),
  format: readFormat,
  body,
});
export const v1Label = z.object({ id: z.string(), name: z.string() });
export const v1Attachment = z.object({
  id: z.string(),
  pageId: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int(),
  uploadedByName: z.string(),
  createdAt: iso,
  url: z.string().describe('이 API로 받는 주소'),
  href: z.string().describe('본문에 `[이름](주소)`로 넣을 위키 안의 주소'),
});
export const v1AttachmentJson = z.object({
  id: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int(),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
});

// ---- 검색·템플릿·휴지통·알림 ----
export const v1SearchHit = z.object({ pageId: z.string(), spaceId: z.string(), spaceName: z.string(), title: z.string(), snippet: z.string(), updatedAt: iso });
export const v1Template = z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), updatedAt: iso, format: readFormat, body });
export const v1TrashPage = z.object({ id: z.string(), title: z.string(), spaceId: z.string(), spaceName: z.string(), deletedAt: iso, deletedByName: z.string() });
export const v1TrashSpace = z.object({ id: z.string(), key: z.string(), name: z.string(), deletedAt: iso, createdByName: z.string() });
export const v1PageRestored = z.object({ ok: z.literal(true), movedToRoot: z.boolean().describe('부모가 없어졌으면 맨 위로 되살린다') });
export const v1Notification = z.object({
  id: z.string(),
  kind: z.enum(NOTIFICATION_KINDS),
  pageId: z.string().nullable(),
  commentId: z.string().nullable(),
  actorName: z.string().nullable().describe('부른 사람 — 모르면 null'),
  actorUsername: z.string().nullable(),
  pageTitle: z.string().nullable(),
  readAt: iso.nullable(),
  createdAt: iso,
});

// ---- 관리 ----
export const v1User = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  role: z.enum(ROLES),
  status: z.enum([...USER_STATUSES, 'locked']),
  mustChangePassword: z.boolean(),
  grants: z.array(z.enum(DELEGABLE_ACTIONS)),
  createdAt: iso,
});
export const v1UserList = z.object({ items: z.array(v1User), total: z.number().int().describe('거른 뒤의 전체 수 — 나누어 읽을 때 쓴다') });
/** 정책값 — 읽는 사람이 `settings.manage`를 가졌으면 전부(키는 정책 표), 아니면 지켜야 할 것만. 모르는 키가 늘어도 깨지지 않게 느슨하다 */
export const v1Policy = z.looseObject({
  uploadMaxMb: z.number().int(),
  allowedExtensions: z.array(z.string()),
  passwordMinLength: z.number().int(),
  passwordMinCharClasses: z.number().int(),
  uploadCeilingMb: z.number().int().describe('서버가 허용하는 업로드 상한(MB) — uploadMaxMb는 이 값을 넘지 못한다'),
});
export const v1AuditEvent = z.object({
  id: z.string(),
  action: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  ip: z.string().nullable(),
  requestId: z.string().nullable().describe('그 행을 남긴 요청의 번호 — 로그 한 줄의 requestId와 같다'),
  createdAt: iso,
});

// ---- 오류 ----
/** 모든 오류는 한 모양이다(FR-2211) — 분기는 문장이 아니라 `code`로 한다 */
export const v1ErrorSchema = z.object({
  error: z.object({
    code: z.string().describe('고정 문자열 — 분기는 이것으로'),
    message: z.string(),
    requestId: z.string().nullable().describe('로그·감사 행과 같은 요청 번호'),
    details: z.unknown().optional(),
  }),
});

