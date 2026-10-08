import { z } from 'zod';
import { requiredScopes } from './api-token';
import { API_RATE_LIMITS } from './constants';
import { policyRangeOf, V1_FIELD_DOCS, V1_RESPONSE_DOCS } from './v1-field-docs';
import {
  auditQueryDto,
  createUserDto,
  listLimitDto,
  listUsersDto,
  policyPatchDto,
  updateUserRoleDto,
  userGrantsDto,
} from './schemas';
import {
  V1_DEFAULTS,
  v1AddMemberDto,
  v1CategoryDto,
  v1CommentDto,
  v1CommentUpdateDto,
  v1CreatePageDto,
  v1CreateSpaceDto,
  v1DownloadQuery,
  v1LabelDto,
  v1MemberRoleDto,
  v1MovePageDto,
  v1PageQuery, v1PageTreeQuery,
  v1SearchQuery,
  v1SpaceListQuery,
  v1SpaceStatusDto,
  v1TemplateDto,
  v1TemplateUpdateDto,
  v1UpdatePageDto,
  v1UpdateSpaceDto,
  v1UploadDto,
} from './v1';
import {
  v1Attachment,
  v1AuditEvent,
  v1Category,
  v1Comment,
  v1Count,
  v1Diff,
  v1ErrorSchema,
  v1Items,
  v1Label,
  v1Member,
  v1MovedPage,
  v1Notification,
  v1Ok,
  v1Page,
  v1PageRestored,
  v1PageTree,
  v1Policy,
  v1SearchHit,
  v1Space,
  v1Template,
  v1TrashPage,
  v1TrashSpace,
  v1User,
  v1UserList,
  v1Version,
  v1VersionSummary,
} from './v1-responses';


/**
 * 공개 API v1의 **OpenAPI 명세** (A등급, docs/spinoff/public-api 설계서 FR-2220·2221·2224 · 계획서 4.3절).
 *
 * 두 가지로 이루어진다. ① `V1_OPERATIONS` — 경로마다 한 줄: 메서드·경로·설명과 **이미 있는 zod 스키마**(요청 `v1.ts`·`schemas.ts`, 응답 `v1-responses.ts`).
 * ② `buildOpenApi` — 그것을 OpenAPI 3.1 문서로 바꾸는 순수 함수. 요청·응답 모양을 손으로 다시 쓰지 않으므로 코드와 명세가 어긋나지 않고, 기본값(`default`)도
 * `V1_DEFAULTS` 한 곳에서 나온다(FR-2224). 경로 표가 실제 컨트롤러와 같은지는 api의 계약 시험이 양방향으로 본다(FR-2221).
 *
 * 이 명세를 읽는 쪽은 사람과 **사내 LLM 서비스(에이전트)** 다 — 그래서 요약·설명은 "어느 경로를 언제 쓰나"를 말한다.
 */

export type V1Op = {
  /** `모듈.동작` — 도구 이름으로 쓰기 좋다 */
  id: string;
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  /** `/api/v1`을 뺀 경로. 칸은 `{이름}`(컨트롤러의 `:이름`과 같다) */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  /** 토큰에 `admin` scope가 더 필요하다 */
  admin?: boolean;
  /** 토큰이 필요 없다 */
  public?: boolean;
  params?: Record<string, { kind: 'uuid' | 'integer' | 'string'; description: string }>;
  query?: z.ZodType;
  body?: z.ZodType;
  /** 파일 올리기(multipart) — 파일 칸(`file`)은 늘 필수다. `body`도 있으면 JSON으로도 올릴 수 있다 */
  multipart?: z.ZodType;
  response: z.ZodType | { contentType: string; description: string };
};

export type OpenApiInfo = { title: string; version: string; description: string };

type Json = Record<string, unknown>;

/** zod → JSON Schema. 입력은 받는 모양(변환 전)을, 출력은 내보내는 모양을 말한다. `$schema`는 뗀다(문서 한 곳에만 있으면 된다) */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const s = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Json;
  delete s.$schema;
  return s;
}

/** 칸의 설명 — 코드가 붙인 것이 먼저, 없으면 칸 설명 표(`V1_FIELD_DOCS`)에서 `동작id.칸`, `칸` 차례로 */
const fieldDoc = (opId: string, field: string): string | undefined => V1_FIELD_DOCS[`${opId}.${field}`] ?? V1_FIELD_DOCS[field];

/** 요청 본문의 칸마다 빠진 설명을 채운다. 정책 정수 칸은 진짜 허용 범위도 적는다 */
function describeFields(schema: Json, opId: string, response = false): void {
  const root = schema as { items?: Json; allOf?: Json[]; anyOf?: Json[]; oneOf?: Json[] };
  if (root.items) describeFields(root.items, opId, response);
  for (const list of [root.allOf, root.anyOf, root.oneOf]) for (const sub of list ?? []) describeFields(sub, opId, response);
  const props = (schema as { properties?: Record<string, Json> }).properties;
  for (const [name, p] of Object.entries(props ?? {})) {
    if (!p.description) {
      const d = response ? V1_RESPONSE_DOCS[name] : fieldDoc(opId, name);
      if (d) p.description = d;
    }
    const range = opId === 'settings.update' ? policyRangeOf(name) : undefined;
    if (range && p.type === 'integer') {
      p.minimum = range.min;
      p.maximum = range.max;
    }
    describeFields(p, opId, response);
    if (p.items) describeFields(p.items as Json, opId, response);
  }
}

const PATH_CALLS = /\{(\w+)\}/g;
const ERROR_REF = { $ref: '#/components/schemas/Error' };
const ERRORS: Record<string, string> = {
  '400': '입력이 틀렸다 — `error.code`와 `error.message`가 까닭을 말한다',
  '401': '토큰이 없거나 쓸 수 없다(만료·폐기·정지) — `TOKEN_*`',
  '403': 'scope가 모자라거나(`INSUFFICIENT_SCOPE`) 사람의 권한이 없다(`FORBIDDEN`) — 토큰은 사람보다 더 할 수 없다',
  '404': '없거나 볼 수 없다 — 둘을 구별하지 않는다',
  '429': '토큰별 빈도 제한을 넘었다 — `Retry-After`(초)만큼 기다린다',
};
const CONFLICT = '기준 버전이 어긋났거나(`VERSION_CONFLICT`) 사람이 편집 중(`PAGE_BEING_EDITED`)이거나 이름이 겹친다';

const errorResponses = (method: V1Op['method']): Json => {
  const out: Json = {};
  for (const [code, description] of Object.entries(ERRORS)) out[code] = { description, content: { 'application/json': { schema: ERROR_REF } } };
  if (method !== 'get') out['409'] = { description: CONFLICT, content: { 'application/json': { schema: ERROR_REF } } };
  return out;
};

const PARAM_SCHEMA = {
  uuid: { type: 'string', format: 'uuid' },
  integer: { type: 'integer' },
  string: { type: 'string' },
} as const;

function parametersOf(op: V1Op): Json[] {
  const named = [...op.path.matchAll(PATH_CALLS)].map((m) => m[1]!);
  const declared = Object.keys(op.params ?? {});
  for (const n of named) if (!declared.includes(n)) throw new Error(`${op.id}: 경로의 {${n}}를 params에 설명하지 않았다`);
  for (const n of declared) if (!named.includes(n)) throw new Error(`${op.id}: params의 ${n}가 경로에 없다`);

  const out: Json[] = named.map((n) => {
    const p = op.params![n]!;
    return { name: n, in: 'path', required: true, description: p.description, schema: { ...PARAM_SCHEMA[p.kind] } };
  });
  if (op.query) {
    const s = jsonSchema(op.query, 'input') as { properties?: Record<string, Json>; required?: string[] };
    for (const [name, schema] of Object.entries(s.properties ?? {})) {
      const { description, ...rest } = schema as { description?: string };
      const doc = description ?? fieldDoc(op.id, name);
      out.push({ name, in: 'query', required: (s.required ?? []).includes(name), ...(doc ? { description: doc } : {}), schema: rest });
    }
  }
  return out;
}

function requestBodyOf(op: V1Op): Json | undefined {
  const content: Json = {};
  if (op.body) {
    const schema = jsonSchema(op.body, 'input');
    describeFields(schema, op.id);
    content['application/json'] = { schema };
  }
  if (op.multipart) {
    const s = jsonSchema(op.multipart, 'input') as { properties?: Json; required?: string[] };
    describeFields(s as Json, op.id);
    content['multipart/form-data'] = {
      schema: { type: 'object', properties: { file: { type: 'string', format: 'binary', description: '올릴 파일 — 이름은 파일 부분의 이름을 쓴다. 허용 확장자·크기는 `GET /settings/policy`' }, ...(s.properties ?? {}) }, required: ['file', ...(s.required ?? [])] },
    };
  }
  return Object.keys(content).length > 0 ? { required: true, content } : undefined;
}

function responseOf(op: V1Op): Json {
  const r = op.response;
  if (r instanceof z.ZodType) {
    const schema = jsonSchema(r, 'output');
    describeFields(schema, op.id, true);
    return { description: '성공', content: { 'application/json': { schema } } };
  }
  return { description: r.description, content: { [r.contentType]: { schema: { type: 'string' } } } };
}

/** 경로 표를 OpenAPI 3.1 문서로. 칸이 어긋나거나 같은 경로·operationId가 둘이면 만들지 않는다 — 조용히 하나가 가려지면 에이전트가 못 부르는 경로가 생긴다 */
export function buildOpenApi(ops: readonly V1Op[], info: OpenApiInfo): object {
  const paths: Record<string, Record<string, Json>> = {};
  const ids = new Set<string>();
  for (const op of ops) {
    if (ids.has(op.id)) throw new Error(`operationId가 겹친다: ${op.id}`);
    ids.add(op.id);
    if (paths[op.path]?.[op.method]) throw new Error(`같은 경로·메서드가 둘이다: ${op.method.toUpperCase()} ${op.path}`);

    const parameters = parametersOf(op);
    const requestBody = requestBodyOf(op);
    const entry: Json = {
      operationId: op.id,
      tags: [op.tag],
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      security: op.public ? [] : [{ bearerAuth: requiredScopes(op.method, op.admin === true) }],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: { '200': responseOf(op), ...(op.public ? {} : errorResponses(op.method)) },
    };
    (paths[op.path] ??= {})[op.method] = entry;
  }
  return {
    openapi: '3.1.0',
    info,
    servers: [{ url: '/api/v1' }],
    tags: [...new Set(ops.map((o) => o.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '화면의 내 정보에서 발급한 API 토큰. `Authorization: Bearer <토큰>`' } },
      schemas: { Error: jsonSchema(v1ErrorSchema, 'output') },
    },
  };
}

// ---- 경로 표 ----

const id = (description: string) => ({ kind: 'uuid' as const, description });
const text = (description: string) => ({ kind: 'string' as const, description });
const int = (description: string) => ({ kind: 'integer' as const, description });
const array = <T extends z.ZodType>(t: T) => z.array(t);
const pageId = { pageId: id('페이지의 id') };
const pid = { id: id('페이지의 id') };
const sid = { id: id('스페이스의 id') };
const uid = { id: id('사용자의 id') };
const formatNote = '`format`(쿼리)으로 본문 형식을 고른다 — markdown(기본)·json·text.';

const exportQuery = z.object({ versionNo: z.coerce.number().int().positive().optional().describe('이 버전을 내보낸다 — 없으면 지금 버전') });

export const V1_OPERATIONS: V1Op[] = [
  // ---- 페이지 ----
  { id: 'pages.tree', method: 'get', path: '/pages', tag: 'pages', summary: '스페이스의 페이지 목록(트리)', description: '스페이스 하나의 페이지를 본문 없이 돌려준다. 각 항목의 `parentId`·`position`으로 트리를 그린다. 본문은 `GET /pages/{id}`로 읽는다.', query: v1PageTreeQuery, response: v1PageTree },
  { id: 'pages.get', method: 'get', path: '/pages/{id}', tag: 'pages', summary: '페이지 읽기', description: `페이지 하나를 본문과 함께 읽는다. 조상 경로(\`ancestors\`)와 지금 버전 번호(\`currentVersionNo\`)가 함께 온다 — 고칠 때 기준 버전으로 쓴다. ${formatNote}`, params: pid, query: v1PageQuery, response: v1Page },
  { id: 'pages.create', method: 'post', path: '/pages', tag: 'pages', summary: '페이지 만들기', description: '필수는 `space`(이름이나 id)·`title`·`body`뿐이다. 부모를 안 주면 맨 위, 위치는 맨 끝에 만들고 서버가 정한 값을 응답이 말한다. 본문은 마크다운이 기본이다(`format`=json이면 문서 객체). 원시 HTML·그림·허용 밖 링크는 400이다.', body: v1CreatePageDto, query: v1PageQuery, response: v1Page },
  { id: 'pages.update', method: 'patch', path: '/pages/{id}', tag: 'pages', summary: '페이지 고치기', description: '고칠 것(`title`·`body`)만 보낸다 — 안 보낸 것은 그대로다. 기준 버전(`baseVersionNo`)을 안 주면 지금 버전이다. 사람이 그 페이지를 실시간으로 편집 중이면 409 `PAGE_BEING_EDITED` — 편집이 끝난 뒤 다시 시도한다. 기준 버전이 어긋나면 409 `VERSION_CONFLICT`.', params: pid, body: v1UpdatePageDto, query: v1PageQuery, response: v1Page },
  { id: 'pages.move', method: 'patch', path: '/pages/{id}/move', tag: 'pages', summary: '페이지 옮기기', description: '부모(`parentId`, null이면 맨 위)만 있으면 된다. 위치를 안 주면 형제의 맨 끝이다.', params: pid, body: v1MovePageDto, response: v1MovedPage },
  { id: 'pages.delete', method: 'delete', path: '/pages/{id}', tag: 'pages', summary: '페이지 지우기(휴지통으로)', description: '휴지통으로 보낸다 — 보존 기간 안에는 `POST /trash/pages/{id}/restore`로 되살린다.', params: pid, response: v1Ok },
  { id: 'pages.versions', method: 'get', path: '/pages/{id}/versions', tag: 'pages', summary: '버전 이력', description: '버전 번호·제목·고친 사람·시각의 목록(본문 없이). 본문은 버전 하나를 읽어 본다.', params: pid, response: array(v1VersionSummary) },
  { id: 'pages.version', method: 'get', path: '/pages/{id}/versions/{no}', tag: 'pages', summary: '옛 버전 읽기', description: `버전 하나의 본문을 읽는다. ${formatNote}`, params: { ...pid, no: int('버전 번호') }, query: v1PageQuery, response: v1Version },
  { id: 'pages.restoreVersion', method: 'post', path: '/pages/{id}/versions/{no}/restore', tag: 'pages', summary: '옛 버전으로 되돌리기', description: '그 버전의 내용을 새 버전으로 더한다(이력은 지워지지 않는다). 편집 중이면 409 `PAGE_BEING_EDITED`.', params: { ...pid, no: int('되돌릴 버전 번호') }, query: v1PageQuery, response: v1Page },
  { id: 'pages.diff', method: 'get', path: '/pages/{id}/versions/{a}/diff/{b}', tag: 'pages', summary: '두 버전 비교', description: '`a` 버전에서 `b` 버전으로 무엇이 바뀌었는지 블록 단위로 돌려준다(추가·삭제·수정 수와 블록별 차이).', params: { ...pid, a: int('앞 버전 번호'), b: int('뒤 버전 번호') }, response: v1Diff },
  { id: 'pages.export', method: 'get', path: '/pages/{id}/export', tag: 'pages', summary: '페이지를 HTML 한 파일로 내보내기', description: '내려받는 파일(`Content-Disposition: attachment`)이다. 감사로그에 남는다.', params: pid, query: exportQuery, response: { contentType: 'text/html', description: 'HTML 한 파일' } },

  // ---- 스페이스·Crew ----
  { id: 'spaces.list', method: 'get', path: '/spaces', tag: 'spaces', summary: '스페이스 목록', description: '내가 볼 수 있는 스페이스. `q`로 이름을 찾고 `limit`으로 자른다.', query: v1SpaceListQuery, response: v1Items(v1Space) },
  { id: 'spaces.get', method: 'get', path: '/spaces/{id}', tag: 'spaces', summary: '스페이스 하나', description: '내 역할(`myRole`)과 할 수 있는 일(`canWrite`·`canManageMembers`)이 함께 온다.', params: sid, response: v1Space },
  { id: 'spaces.create', method: 'post', path: '/spaces', tag: 'spaces', summary: '팀 스페이스 만들기', description: '필수는 `name`뿐이다. 종류는 팀, 설명은 빈 글, 분류는 없음이 기본이다. 분류는 **이름으로** 고르고 없는 이름이면 404와 고를 수 있는 이름을 돌려준다.', body: v1CreateSpaceDto, response: v1Space },
  { id: 'spaces.update', method: 'patch', path: '/spaces/{id}', tag: 'spaces', summary: '스페이스 이름·설명·분류 고치기', description: '고칠 것만 보낸다. 분류는 null이면 지운다.', params: sid, body: v1UpdateSpaceDto, response: v1Space },
  { id: 'spaces.setStatus', method: 'patch', path: '/spaces/{id}/status', tag: 'spaces', summary: '스페이스 중지·다시 쓰기', description: '`status`가 suspended면 중지, active면 다시 쓰기. 관리자가 건 중지는 권한을 받은 주인만 푼다. `takeover`는 주인이 건 중지를 관리자가 넘겨받을 때만(중지에만).', params: sid, body: v1SpaceStatusDto, response: v1Space },
  { id: 'spaces.delete', method: 'delete', path: '/spaces/{id}', tag: 'spaces', summary: '스페이스 지우기(휴지통으로)', description: '휴지통으로 보낸다. Crew가 둘 이상이면 주인도 못 지우고, 중지된 스페이스는 관리자(와 "스페이스 관리 전체"를 받은 사람)만 지운다 — 403. 그 사이 상태가 바뀌었으면 409. 되살리기는 `POST /trash/spaces/{id}/restore`(관리자만).', params: sid, response: v1Ok },
  { id: 'spaces.members', method: 'get', path: '/spaces/{id}/members', tag: 'spaces', summary: 'Crew 목록', params: sid, description: '스페이스에 들어 있는 사람과 역할(owner·editor·viewer).', response: array(v1Member) },
  { id: 'spaces.addMember', method: 'post', path: '/spaces/{id}/members', tag: 'spaces', summary: 'Crew에 사람 넣기', description: '사용자 이름(`username`)만 있으면 된다. 역할은 editor가 기본이다(owner 자리는 줄 수 없다). 바뀐 Crew 목록 전체를 돌려준다.', params: sid, body: v1AddMemberDto, response: array(v1Member) },
  { id: 'spaces.setMemberRole', method: 'patch', path: '/spaces/{id}/members/{ref}', tag: 'spaces', summary: 'Crew의 역할 바꾸기', description: '`ref`는 사람의 사용자 이름이나 id. 하나뿐인 owner는 내릴 수 없다. 바뀐 Crew 목록 전체를 돌려준다.', params: { ...sid, ref: text('사용자 이름이나 id') }, body: v1MemberRoleDto, response: array(v1Member) },
  { id: 'spaces.removeMember', method: 'delete', path: '/spaces/{id}/members/{ref}', tag: 'spaces', summary: 'Crew에서 빼기', description: '`ref`는 사용자 이름이나 id. 하나뿐인 owner는 뺄 수 없다. 바뀐 Crew 목록 전체를 돌려준다.', params: { ...sid, ref: text('사용자 이름이나 id') }, response: array(v1Member) },

  // ---- 분류 ----
  { id: 'categories.list', method: 'get', path: '/categories', tag: 'categories', summary: '분류 목록', description: '스페이스를 묶는 분류. 각 항목이 내가 이름을 바꾸거나 지울 수 있는지(`canRename`·`canDelete`)를 말한다.', response: array(v1Category) },
  { id: 'categories.create', method: 'post', path: '/categories', tag: 'categories', summary: '분류 만들기', description: '이름만 있으면 된다.', body: v1CategoryDto, response: v1Category },
  { id: 'categories.rename', method: 'patch', path: '/categories/{id}', tag: 'categories', summary: '분류 이름 바꾸기', description: '만든 사람과 관리자(남의 스페이스가 쓰면 관리자와 "분류 관리"를 받은 사람)만.', params: { id: id('분류의 id') }, body: v1CategoryDto, response: v1Category },
  { id: 'categories.delete', method: 'delete', path: '/categories/{id}', tag: 'categories', summary: '분류 지우기', description: '지우면 그 분류를 쓰던 스페이스는 분류 없음이 된다.', params: { id: id('분류의 id') }, response: v1Ok },

  // ---- 댓글 ----
  { id: 'comments.list', method: 'get', path: '/pages/{pageId}/comments', tag: 'comments', summary: '페이지의 댓글', description: `댓글과 답글(\`parentId\`)을 시간순으로. ${formatNote}`, params: pageId, query: v1PageQuery, response: v1Items(v1Comment) },
  { id: 'comments.create', method: 'post', path: '/pages/{pageId}/comments', tag: 'comments', summary: '댓글 쓰기', description: '필수는 `body`뿐이다. 답글이면 `parentId`. 본문의 `@사용자`는 멘션이 되어 알림이 간다.', params: pageId, body: v1CommentDto, query: v1PageQuery, response: v1Comment },
  { id: 'comments.update', method: 'patch', path: '/comments/{id}', tag: 'comments', summary: '댓글 고치기', description: '내가 쓴 댓글만 고칠 수 있다. 본문 형식은 쓰기 형식(markdown·json)이다.', params: { id: id('댓글의 id') }, body: v1CommentUpdateDto, query: v1PageQuery, response: v1Comment },
  { id: 'comments.delete', method: 'delete', path: '/comments/{id}', tag: 'comments', summary: '댓글 지우기', description: '쓴 사람, 또는 그 스페이스에 쓸 수 있고 페이지를 지울 권한이 있는 사람만 지운다(중지된 스페이스에서는 아무도). 답글은 함께 지워지지 않는다.', params: { id: id('댓글의 id') }, response: v1Ok },

  // ---- 라벨 ----
  { id: 'labels.list', method: 'get', path: '/labels', tag: 'labels', summary: '모든 라벨', description: '쓰이는 라벨의 이름 목록.', query: listLimitDto, response: array(v1Label) },
  { id: 'labels.pages', method: 'get', path: '/labels/{name}/pages', tag: 'labels', summary: '라벨이 붙은 페이지', description: '그 라벨이 붙은, 내가 읽을 수 있는 페이지.', params: { name: text('라벨 이름') }, query: listLimitDto, response: v1Items(v1SearchHit) },
  { id: 'labels.forPage', method: 'get', path: '/pages/{pageId}/labels', tag: 'labels', summary: '페이지의 라벨', description: '그 페이지에 붙은 라벨.', params: pageId, response: array(v1Label) },
  { id: 'labels.attach', method: 'post', path: '/pages/{pageId}/labels', tag: 'labels', summary: '라벨 붙이기', description: '이름만 있으면 된다 — 없는 라벨이면 만든다. 이름은 소문자로 저장된다.', params: pageId, body: v1LabelDto, response: v1Label },
  { id: 'labels.detach', method: 'delete', path: '/pages/{pageId}/labels/{ref}', tag: 'labels', summary: '라벨 떼기', description: '`ref`는 라벨의 이름이나 id.', params: { ...pageId, ref: text('라벨의 이름이나 id') }, response: v1Ok },

  // ---- 첨부 ----
  { id: 'attachments.list', method: 'get', path: '/pages/{pageId}/attachments', tag: 'attachments', summary: '페이지의 첨부', description: '`href`는 본문에 `[이름](주소)`로 넣으면 사람이 눌러 받는 주소다(문서에는 그림 노드가 없어 링크로 건다).', params: pageId, response: v1Items(v1Attachment) },
  { id: 'attachments.upload', method: 'post', path: '/pages/{pageId}/attachments', tag: 'attachments', summary: '첨부 올리기', description: 'JSON(`filename`·`content`·`encoding`: 글은 utf8, 바이너리는 base64)이나 multipart(`file`)로 올린다. 형식(mime)은 받지 않고 확장자에서 정한다. 종류·크기 규칙은 화면과 같다.', params: pageId, body: v1UploadDto, multipart: z.object({}), response: v1Attachment },
  { id: 'attachments.download', method: 'get', path: '/attachments/{id}', tag: 'attachments', summary: '첨부 받기', description: `기본은 바이너리 그대로다. \`format=json\`이면 글은 utf8, 바이너리는 base64로 JSON에 담는다(${V1_DEFAULTS.attachmentJsonMaxBytes}바이트까지 — 넘으면 413). 받은 일은 감사에 남는다.`, params: { id: id('첨부의 id') }, query: v1DownloadQuery, response: { contentType: 'application/octet-stream', description: '파일 내용. `format=json`이면 application/json의 { id, filename, mime, size, encoding, content }' } },
  { id: 'attachments.delete', method: 'delete', path: '/attachments/{id}', tag: 'attachments', summary: '첨부 지우기', description: '그 스페이스에 쓸 수 있는 사람, 또는 올린 사람이 지운다(중지된 스페이스에서는 아무도).', params: { id: id('첨부의 id') }, response: v1Ok },

  // ---- 검색 ----
  { id: 'search.find', method: 'get', path: '/search', tag: 'search', summary: '페이지 검색', description: '필수는 검색어(`q`)뿐이다 — 내가 읽을 수 있는 모든 스페이스에서 찾는다. `space`(이름이나 id)로 좁힌다. 없는 스페이스 이름은 빈 결과가 아니라 404 `SPACE_NOT_FOUND`다. 모르는 쿼리 칸은 400.', query: v1SearchQuery, response: v1Items(v1SearchHit) },

  // ---- 템플릿 ----
  { id: 'templates.list', method: 'get', path: '/templates', tag: 'templates', summary: '페이지 템플릿 목록', description: `새 페이지의 본문으로 쓸 틀. 본문을 읽어 \`POST /pages\`의 \`body\`로 보내면 된다. ${formatNote}`, query: v1PageQuery, response: v1Items(v1Template) },
  { id: 'templates.create', method: 'post', path: '/templates', tag: 'templates', summary: '템플릿 만들기', description: '**관리자만.** 이름과 본문이면 된다(설명은 선택). 같은 이름·내용이면 있던 것을 돌려준다.', body: v1TemplateDto, query: v1PageQuery, response: v1Template },
  { id: 'templates.update', method: 'patch', path: '/templates/{id}', tag: 'templates', summary: '템플릿 고치기', description: '**관리자만.** 고칠 것만 보낸다. 설명은 null이면 지운다.', params: { id: id('템플릿의 id') }, body: v1TemplateUpdateDto, query: v1PageQuery, response: v1Template },
  { id: 'templates.delete', method: 'delete', path: '/templates/{id}', tag: 'templates', summary: '템플릿 지우기', description: '**관리자만** 지울 수 있다. 지운 템플릿은 되살릴 수 없다.', params: { id: id('템플릿의 id') }, response: v1Ok },

  // ---- 휴지통 ----
  { id: 'trash.pages', method: 'get', path: '/trash/pages', tag: 'trash', summary: '휴지통의 페이지', description: '내가 되살릴 수 있는 것만.', query: listLimitDto, response: v1Items(v1TrashPage) },
  { id: 'trash.restorePage', method: 'post', path: '/trash/pages/{id}/restore', tag: 'trash', summary: '페이지 되살리기', description: '부모가 없어졌으면 맨 위로 되살리고 `movedToRoot`가 참이다.', params: pid, response: v1PageRestored },
  { id: 'trash.spaces', method: 'get', path: '/trash/spaces', tag: 'trash', summary: '휴지통의 스페이스', description: '내가 되살릴 수 있는 것만.', query: listLimitDto, response: v1Items(v1TrashSpace) },
  { id: 'trash.restoreSpace', method: 'post', path: '/trash/spaces/{id}/restore', tag: 'trash', summary: '스페이스 되살리기', description: '**관리자만**(주인은 403).', params: sid, response: v1Ok },

  // ---- 알림 ----
  { id: 'notifications.list', method: 'get', path: '/notifications', tag: 'notifications', summary: '내 알림', description: '**자기 것만** 본다 — 사용자 id를 받는 경로가 없다.', query: listLimitDto, response: v1Items(v1Notification) },
  { id: 'notifications.unreadCount', method: 'get', path: '/notifications/unread-count', tag: 'notifications', summary: '안 읽은 알림 수', description: '내 안 읽은 알림의 수.', response: v1Count },
  { id: 'notifications.read', method: 'post', path: '/notifications/{id}/read', tag: 'notifications', summary: '알림 읽음 표시', description: '남의 알림이면 404.', params: { id: id('알림의 id') }, response: v1Ok },
  { id: 'notifications.readAll', method: 'post', path: '/notifications/read-all', tag: 'notifications', summary: '알림 모두 읽음', description: '읽음으로 바뀐 수를 돌려준다.', response: v1Count },

  // ---- 관리 (admin scope가 더 필요하다) ----
  { id: 'users.list', method: 'get', path: '/users', tag: 'admin', admin: true, summary: '사용자 목록', description: '이름·아이디로 찾고(`q`) 상태로 거르고(`status`) 나누어 읽는다(`limit`·`offset`, 전체 수는 `total`).', query: listUsersDto, response: v1UserList },
  { id: 'users.create', method: 'post', path: '/users', tag: 'admin', admin: true, summary: '사용자 만들기', description: '활성 계정과 개인 스페이스가 함께 생긴다. 비밀번호는 응답에 없다.', body: createUserDto, response: v1User },
  { id: 'users.approve', method: 'post', path: '/users/{id}/approve', tag: 'admin', admin: true, summary: '가입 승인', description: '승인 대기를 활성으로 바꾸고 개인 스페이스를 만든다.', params: uid, response: v1User },
  { id: 'users.unlock', method: 'post', path: '/users/{id}/unlock', tag: 'admin', admin: true, summary: '잠금 해제', description: '로그인 실패로 잠긴 계정을 푼다.', params: uid, response: v1User },
  { id: 'users.suspend', method: 'post', path: '/users/{id}/suspend', tag: 'admin', admin: true, summary: '계정 정지', description: '그 사람의 세션·토큰·편집 연결이 그 자리에서 끊기고 로그인하지 못한다. 내용·감사는 남는다.', params: uid, response: v1User },
  { id: 'users.unsuspend', method: 'post', path: '/users/{id}/unsuspend', tag: 'admin', admin: true, summary: '정지 풀기', description: '정지한 계정을 활성으로 되돌린다.', params: uid, response: v1User },
  { id: 'users.terminateSessions', method: 'post', path: '/users/{id}/terminate-sessions', tag: 'admin', admin: true, summary: '세션 모두 끊기', description: '끊은 세션의 수를 돌려준다.', params: uid, response: v1Count },
  { id: 'users.setRole', method: 'patch', path: '/users/{id}/role', tag: 'admin', admin: true, summary: '역할 바꾸기', description: 'root만 root를 줄 수 있다. 자기가 할 수 없는 위임을 가진 사람은 바꾸지 못한다.', params: uid, body: updateUserRoleDto, response: v1User },
  { id: 'users.setGrants', method: 'put', path: '/users/{id}/grants', tag: 'admin', admin: true, summary: '맡기는 권한 주고 거두기', description: '`grants`로 그 사람의 위임을 통째로 바꾼다. 받는 역할이 아니면 사라진다.', params: uid, body: userGrantsDto, response: v1User },
  { id: 'settings.get', method: 'get', path: '/settings/policy', tag: 'admin', admin: true, summary: '운영 정책값 읽기', description: '업로드 크기·허용 확장자·세션 시간·비밀번호 규칙·잠금·보존 기간 등. 서버의 천장(`uploadCeilingMb`)이 함께 온다.', response: v1Policy },
  { id: 'settings.update', method: 'patch', path: '/settings/policy', tag: 'admin', admin: true, summary: '운영 정책값 고치기', description: '고칠 값만 보낸다. 범위를 벗어나면 400. 감사 기록 단계는 시스템 관리자(root)만 바꾼다.', body: policyPatchDto, response: v1Ok },
  { id: 'audit.list', method: 'get', path: '/audit', tag: 'admin', admin: true, summary: '감사로그 읽기', description: '행위(`action`)·사람(`actorId`)·기간(`from`·`to`)·요청 번호(`requestId`)로 거른다. 읽기 전용이다(append-only) — 쓰는 경로는 없다. 응답을 `{items}`로 싼다(화면용은 배열).', query: auditQueryDto, response: v1Items(v1AuditEvent) },

  // ---- 명세 ----
  { id: 'spec.openapi', method: 'get', path: '/openapi.json', tag: 'spec', public: true, summary: '이 명세', description: '인증 없이 받는다. 이 문서 자체다.', response: z.looseObject({ openapi: z.string() }) },
];

export const V1_OPENAPI_INFO: OpenApiInfo = {
  title: '워크플루언스 공개 API',
  version: '1.0.0',
  description: [
    '사내 위키(워크플루언스)의 기능을 프로그램·에이전트가 쓰는 REST API다. 화면과 같은 서비스·권한을 쓴다 — **토큰은 그 주인이 화면에서 할 수 있는 일을 넘지 못한다.**',
    '',
    '인증: 화면의 내 정보에서 토큰을 발급해 `Authorization: Bearer <토큰>`으로 보낸다(쿠키·CSRF 헤더는 필요 없다). scope는 read(읽기)·write(쓰기, read 포함)·admin(관리 경로에 **더** 필요).',
    `빈도 제한: 토큰마다 읽기 ${API_RATE_LIMITS.read.max}번·쓰기 ${API_RATE_LIMITS.write.max}번 / ${API_RATE_LIMITS.read.windowSec}초. 넘으면 429와 \`Retry-After\`.`,
    '오류: 모두 `{ "error": { "code", "message", "requestId" } }` 한 모양이다. 분기는 문장이 아니라 `code`로 한다. `requestId`를 알려 주면 운영자가 로그·감사에서 그 요청을 찾는다.',
    `본문: 읽기는 markdown(기본)·json·text, 쓰기는 markdown(기본)·json. 만들 때 필수는 대개 이름·제목·본문뿐이고 나머지는 서버가 기본값(예: 목록 ${V1_DEFAULTS.listLimit}개)으로 채워 응답이 그 값을 말한다.`,
    '이 API는 더하기만 한다(필드·경로 추가). 빼거나 뜻을 바꾸면 v2다.',
  ].join('\n'),
};
