import { z } from 'zod';
import { MARKDOWN_LIMITS } from './constants';
import { extractText, validateDocument, type DocNode } from './document';
import { renderDocMarkdown } from './markdown';
import { parseMarkdown } from './markdown-parse';
import { idSchema } from './schemas';

/**
 * 공개 API v1의 계약 중 순수한 부분 (A등급, docs/spinoff/public-api 설계서 3.3·3.5절 · FR-2211·2215·2223~2225).
 *
 * **에이전트용 단순 계약**(사용자 지시 2026-10-07): 에이전트가 정하는 것은 어디(스페이스)·제목·본문뿐이고 나머지는 서버가 기본값으로 채운다.
 * 그 기본값은 이 파일의 `V1_DEFAULTS` **한 곳**에 있고, OpenAPI의 `default`와 사용가이드가 거기서 나온다.
 */

export const V1_DEFAULTS = {
  /** 쓸 때 본문의 형식 — 에이전트는 마크다운을 쓴다 */
  writeFormat: 'markdown',
  /** 읽을 때 본문의 형식 — 마크다운이 JSON 트리보다 훨씬 짧아 에이전트의 문맥을 덜 쓴다 */
  readFormat: 'markdown',
  /** 목록·트리의 상한 */
  listLimit: 200,
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

const spaceRef = z.string().trim().min(1).max(200);
const titleSchema = z.string().trim().min(1).max(300);
const bodyField = z.unknown().refine((v) => v !== undefined, { message: '본문(body)이 필요하다' });

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
    format: z.enum(V1_WRITE_FORMATS).default(V1_DEFAULTS.writeFormat),
    parentId: idSchema.nullable().default(null),
  })
  .transform((v, ctx) => ({ space: v.space, title: v.title, parentId: v.parentId, doc: convert(v.format, v.body, ctx) }));
export type V1CreatePageDto = z.infer<typeof v1CreatePageDto>;

/** 페이지 고치기 — 고칠 것만. 기준 버전을 안 주면 서버가 지금 버전을 쓴다(편집 중이면 409 — 설계서 FR-2216) */
export const v1UpdatePageDto = z
  .strictObject({
    title: titleSchema.optional(),
    body: z.unknown().optional(),
    format: z.enum(V1_WRITE_FORMATS).default(V1_DEFAULTS.writeFormat),
    baseVersionNo: z.number().int().positive().optional(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined, { message: '고칠 것이 없다 — title이나 body 중 하나는 있어야 한다' })
  .transform((v, ctx) => ({
    title: v.title,
    doc: v.body === undefined ? undefined : convert(v.format, v.body, ctx),
    baseVersionNo: v.baseVersionNo,
  }));
export type V1UpdatePageDto = z.infer<typeof v1UpdatePageDto>;

/** 읽기의 형식 — 없으면 마크다운 */
export const v1PageQuery = z.object({ format: z.enum(V1_READ_FORMATS).default(V1_DEFAULTS.readFormat) });
export type V1PageQuery = z.infer<typeof v1PageQuery>;

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
