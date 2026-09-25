import type { DocDiff } from './diff';
import { z } from 'zod';
import {
  ASSIGNABLE_MEMBER_ROLES,
  LLM_LIMITS,
  ROLES,
  SPACE_KINDS,
  SPACE_MEMBER_ROLES,
  SPACE_STATUSES,
  USER_STATUSES,
} from './constants';
import { validateDocument, type DocNode } from './document';
import { normalizeLlmBaseUrl, type LlmStreamStatus } from './llm';
import { DELEGABLE_ACTIONS, type DelegableAction } from './permissions';
import { POLICY_FLOOR } from './policy';

/** API 요청·응답 계약. 서버(zod 파이프)와 클라이언트(타입)가 같은 정의를 쓴다. */

export const documentSchema = z
  .unknown()
  .superRefine((v, ctx) => {
    const r = validateDocument(v);
    if (!r.ok) ctx.addIssue({ code: 'custom', message: `본문 검증 실패: ${r.errors.join('; ')}` });
  })
  .transform((v) => v as DocNode);

/**
 * 비밀번호 **계약**. 바닥(8자)만 본다.
 *
 * 세기(최소 길이·문자 종류)는 운영이 조절하는 값이라 **서비스가 살아 있는 정책값으로**
 * 판정한다 (`users.service.ts`의 `assertPasswordStrength`). 여기서 현재 정책을 강제하면
 * 파싱 시점에 굳어, 관리자가 기준을 **낮춰도** 영영 안 먹는다 (P4 자체 점검 2).
 */
export const passwordSchema = z.string().min(POLICY_FLOOR.passwordMinLength, `${POLICY_FLOOR.passwordMinLength}자 이상`);

export const usernameSchema = z.string().trim().regex(/^[a-z0-9._-]{2,64}$/, '소문자·숫자·._- 2~64자');
// zod 4의 z.email()은 검증만 하므로 정규화(trim·소문자)를 먼저 하고 파이프한다. TLD는 2자 이상이어야 통과한다
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('올바른 email 형식이 아니다'));
/**
 * **줄바꿈을 막는다.** 이 값은 멘션 메일의 제목에 들어간다 (P6 FR-753). 지금 발송은
 * JSON이라 무해하지만, 사내 메일 API가 제목을 SMTP 헤더로 옮기는 순간 헤더 인젝션이
 * 된다 (보류 18). **그 날 코드를 고칠 사람이 이 연결을 기억할 것이라고 기대하지 않는다**
 * (P6 보안 검토 참고 3).
 */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((v) => !/[\r\n]/.test(v), { message: '표시 이름에 줄바꿈을 넣을 수 없다' });

// ---- 인증·계정 ----

export const loginDto = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginDto = z.infer<typeof loginDto>;

export const signupDto = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email: emailSchema,
  password: passwordSchema,
});
export type SignupDto = z.infer<typeof signupDto>;

/** ID 찾기: email만으로는 계정 열거가 가능하므로 이름도 함께 요구한다 (prototype-v2 2절 3번) */
export const findIdDto = z.object({
  email: emailSchema,
  displayName: displayNameSchema,
});
export type FindIdDto = z.infer<typeof findIdDto>;

export const recoverPasswordDto = z.object({
  username: usernameSchema,
  email: emailSchema,
});
export type RecoverPasswordDto = z.infer<typeof recoverPasswordDto>;

export const changePasswordDto = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, { message: '새 비밀번호가 현재 비밀번호와 같다', path: ['newPassword'] });
export type ChangePasswordDto = z.infer<typeof changePasswordDto>;

// ---- 사용자 관리 ----

export const createUserDto = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(ROLES),
});
export type CreateUserDto = z.infer<typeof createUserDto>;

export const updateUserRoleDto = z.object({ role: z.enum(ROLES) });
export type UpdateUserRoleDto = z.infer<typeof updateUserRoleDto>;

// ---- 카테고리·스페이스 ----

export const createCategoryDto = z.object({ name: z.string().trim().min(1).max(50) });
export type CreateCategoryDto = z.infer<typeof createCategoryDto>;

export const createSpaceDto = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(SPACE_KINDS),
  categoryId: z.uuid().nullable().default(null),
  description: z.string().trim().max(2000).default(''),
});
export type CreateSpaceDto = z.infer<typeof createSpaceDto>;

export const updateSpaceDto = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  categoryId: z.uuid().nullable().optional(),
});
export type UpdateSpaceDto = z.infer<typeof updateSpaceDto>;

export const spaceStatusDto = z.object({ status: z.enum(SPACE_STATUSES) });
export type SpaceStatusDto = z.infer<typeof spaceStatusDto>;

export const addMemberDto = z.object({
  username: usernameSchema,
  role: z.enum(ASSIGNABLE_MEMBER_ROLES),
});
export type AddMemberDto = z.infer<typeof addMemberDto>;

export const updateMemberRoleDto = z.object({ role: z.enum(ASSIGNABLE_MEMBER_ROLES) });
export type UpdateMemberRoleDto = z.infer<typeof updateMemberRoleDto>;

export const spaceListQueryDto = z.object({
  scope: z.enum(['personal', 'team', 'all']).default('personal'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type SpaceListQueryDto = z.infer<typeof spaceListQueryDto>;

/**
 * 감사로그 조회 조건 (FR-531).
 *
 * **거를 수 없으면 "추적한다"가 성립하지 않는다** — 수만 건에서 눈으로 찾을 수는 없다.
 */
export const auditQueryDto = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  action: z.string().trim().max(60).optional(),
  actorId: z.uuid().optional(),
  /** 포함. 날짜만 주면 그날 00:00부터 */
  from: z.coerce.date().optional(),
  /** 제외. 날짜만 주면 그날 00:00까지 */
  to: z.coerce.date().optional(),
});
export type AuditQueryDto = z.infer<typeof auditQueryDto>;

export const listLimitDto = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

// ---- 페이지 ----

export const createPageDto = z.object({
  spaceId: z.uuid(),
  parentId: z.uuid().nullable().default(null),
  title: z.string().trim().min(1).max(300),
  content: documentSchema,
});
export type CreatePageDto = z.infer<typeof createPageDto>;

/** baseVersionNo: 편집을 시작한 시점의 버전. 서버의 현재 버전과 다르면 409 (CLAUDE.md 6절 충돌 감지) */
export const updatePageDto = z.object({
  title: z.string().trim().min(1).max(300),
  content: documentSchema,
  baseVersionNo: z.number().int().positive(),
});
export type UpdatePageDto = z.infer<typeof updatePageDto>;

export const movePageDto = z.object({
  parentId: z.uuid().nullable(),
  position: z.number().int().min(0),
});
export type MovePageDto = z.infer<typeof movePageDto>;

/** 댓글 (P3_설계서_Content 5절, FR-420·421). 본문은 페이지와 같은 문서 검증을 쓴다 */
export const createCommentDto = z.object({
  parentId: z.uuid().nullable().optional(),
  body: documentSchema,
});
export type CreateCommentDto = z.infer<typeof createCommentDto>;

export const updateCommentDto = z.object({ body: documentSchema });
export type UpdateCommentDto = z.infer<typeof updateCommentDto>;

/** 정책값 변경. **모양만** 본다 — 범위·허용값 판정은 `validatePolicyPatch`(A등급)가 한다 */
export const policyPatchDto = z
  .object({
    uploadMaxMb: z.number().int().optional(),
    allowedExtensions: z.array(z.string()).optional(),
    sessionIdleMinutes: z.number().int().optional(),
    sessionAbsoluteHours: z.number().int().optional(),
    passwordMinLength: z.number().int().optional(),
    passwordMinCharClasses: z.number().int().optional(),
    lockoutThreshold: z.number().int().optional(),
    lockoutMinutes: z.number().int().optional(),
    trashRetentionDays: z.number().int().optional(),
    auditRetentionDays: z.number().int().optional(),
    llmRetentionDays: z.number().int().optional(),
    llmConversationMax: z.number().int().optional(),
    llmPinnedMax: z.number().int().optional(),
  })
  .strict();
export type PolicyPatchDto = z.infer<typeof policyPatchDto>;

/**
 * **식별자 모양인가** — 서버의 경로 검증(`UuidPipe`)과 화면의 경로 지킴(`RequireUuidParam`)이 같은 판정을 쓴다. 화면은 주소의 id를
 * API 경로에 넣는데, 라우터가 주소의 `%2F`를 풀어 넘기므로 id 모양이 아닌 것은 경로의 하위 조각이 된다 (P10 종료 루틴 — 경로 조작)
 */
export function isUuid(v: unknown): v is string {
  return z.uuid().safeParse(v).success;
}

/**
 * 라벨 이름. **`.`·`..`은 받지 않는다** — 라벨 페이지는 이름을 API 경로에 넣고(`/api/labels/{이름}/pages`), `encodeURIComponent`는
 * 점을 싸지 않아 URL 해석이 그 조각을 점 조각으로 읽는다(다른 API를 가리킨다). 화면의 `api()`도 그런 경로를 보내지 않는다 (P10 종료 루틴)
 */
export const attachLabelDto = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((v) => v !== '.' && v !== '..', '라벨 이름은 "."이나 ".."일 수 없다'),
});
export type AttachLabelDto = z.infer<typeof attachLabelDto>;

/**
 * 위임 목록 전체 (P11 F절) — 켜고 끄는 두 상태뿐이라 목록을 통째로 보낸다(멱등). 위임할 수 있는 행위만, 겹치지 않게
 */
export const userGrantsDto = z
  .object({
    grants: z.array(z.enum(DELEGABLE_ACTIONS)).refine((a) => new Set(a).size === a.length, '같은 위임을 두 번 적었다'),
  })
  .strict();
export type UserGrantsDto = z.infer<typeof userGrantsDto>;

export const searchQueryDto = z.object({
  q: z.string().trim().min(1).max(200),
  spaceId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQueryDto = z.infer<typeof searchQueryDto>;

// ---- 설정 ----

export const contactSettingsDto = z.object({ message: z.string().trim().max(2000) });
export type ContactSettingsDto = z.infer<typeof contactSettingsDto>;

// ---- 응답 타입 (클라이언트용) ----

export type UserStatusView = (typeof USER_STATUSES)[number] | 'locked';

export type UserView = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: (typeof ROLES)[number];
  status: UserStatusView;
  mustChangePassword: boolean;
  /** root가 준 행위 — 관리자만 가진다 (P11 D.1) */
  grants: DelegableAction[];
  createdAt: string;
};

export type MeView = {
  id: string;
  username: string;
  displayName: string;
  role: (typeof ROLES)[number];
  mustChangePassword: boolean;
  /** root가 준 행위 — 화면이 `can()`에 함께 넘긴다 (P11 D.1) */
  grants: DelegableAction[];
};

export type CategoryView = { id: string; name: string; createdAt: string };

export type SpaceView = {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: (typeof SPACE_KINDS)[number];
  status: (typeof SPACE_STATUSES)[number];
  categoryId: string | null;
  categoryName: string | null;
  createdBy: string;
  createdByUsername: string;
  memberCount: number;
  myRole: (typeof SPACE_MEMBER_ROLES)[number] | null;
  access: { canRead: boolean; canWrite: boolean; canManageMembers: boolean; canChangeStatus: boolean; canDelete: boolean; isOwner: boolean };
  createdAt: string;
  updatedAt: string;
};

export type SpaceMemberView = {
  userId: string;
  username: string;
  displayName: string;
  role: (typeof SPACE_MEMBER_ROLES)[number];
  createdAt: string;
};

export type PageSummary = {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  position: number;
  currentVersionNo: number;
  updatedAt: string;
};
export type PageView = PageSummary & {
  content: DocNode;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
};
export type PageVersionView = {
  versionNo: number;
  title: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
};
/** 실시간 편집을 **지금 바로** 버전으로 남긴다 (P6_설계서_Collab). 제목도 함께 온다 */
export const flushCollabDto = z.object({ title: z.string().trim().min(1).max(300).optional() });
export type FlushCollabDto = z.infer<typeof flushCollabDto>;

/** 페이지 템플릿 (P6_설계서_Collab FR-740) */
export type PageTemplateView = {
  id: string;
  name: string;
  description: string | null;
  content: DocNode;
  updatedAt: string;
};

export const createTemplateDto = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).nullish(),
  content: documentSchema,
});
export type CreateTemplateDto = z.infer<typeof createTemplateDto>;

export const updateTemplateDto = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(200).nullish(),
    content: documentSchema.optional(),
  })
  // **빈 몸통을 거부한다.** 아무것도 안 바꾸는 요청이 200을 받으면 화면은 바뀐 줄 안다
  .refine((v) => v.name !== undefined || v.description !== undefined || v.content !== undefined, {
    message: '바꿀 것을 하나는 줘야 한다',
  });
export type UpdateTemplateDto = z.infer<typeof updateTemplateDto>;

/** 두 버전을 나란히 볼 때 화면이 받는 것 (P6_설계서_Collab FR-720) */
export type PageDiffView = {
  from: { versionNo: number; title: string; createdByName: string; createdAt: string };
  to: { versionNo: number; title: string; createdByName: string; createdAt: string };
  titleChanged: boolean;
  diff: DocDiff;
};

export type AttachmentView = {
  id: string;
  pageId: string;
  filename: string;
  mime: string;
  size: number;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
};
export type CommentView = {
  id: string;
  pageId: string;
  parentId: string | null;
  body: DocNode;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  /** 지울 수 있는지. 화면이 규칙을 다시 구현하지 않게 서버가 판정해 내려 준다 */
  canDelete: boolean;
};
export type LabelView = { id: string; name: string };
export type TrashPageView = { id: string; title: string; spaceId: string; spaceName: string; deletedAt: string; deletedByName: string };
export type TrashSpaceView = { id: string; key: string; name: string; deletedAt: string; createdByName: string };
export type NotificationView = {
  id: string;
  kind: 'mention';
  pageId: string | null;
  commentId: string | null;
  /**
   * 부른 사람. **`null`이면 모른다** — 실시간 편집에서 그 멘션을 누가 만들었는지 확실하지
   * 않을 때다. 틀린 이름을 적는 대신 비운다 (P8_설계서_Mention FR-901)
   */
  actorName: string | null;
  /** 대상이 지워졌으면 null이다 (FR-506) — 알림은 남되 링크는 대상이 없음을 알린다 */
  pageTitle: string | null;
  readAt: string | null;
  createdAt: string;
};
export type SearchHit = { pageId: string; spaceId: string; spaceName: string; title: string; snippet: string; updatedAt: string };
export type AuditEventView = {
  id: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
};
export type ContactInfoView = { message: string; admins: string[] };
export type SystemInfoView = {
  version: string;
  node: string;
  postgres: string;
  uptimeSec: number;
  counts: { users: number; pendingUsers: number; spaces: number; pages: number; auditEvents: number };
};

// ---- 사내 LLM (P10_설계서_Llm F절) ----

/**
 * **U+0000을 받지 않는다** (검토 반영 — 보안 검토 3). PostgreSQL text가 거부해 저장이 실패하고, 그 오류 문장(drizzle)에는 질의의
 * 매개변수 — 곧 본문 — 이 그대로 있어 로그로 샌다. 받는 자리에서 막는다
 */
const noNul = (v: string) => !v.includes('\u0000');
const NUL_MESSAGE = '글자 U+0000은 넣을 수 없다';

/** 이름 — 줄바꿈을 막는다. 화면 목록과 감사로그에 한 줄로 들어간다 */
const llmNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LLM_LIMITS.nameMaxChars)
  .refine((v) => !/[\r\n]/.test(v), { message: '이름에 줄바꿈을 넣을 수 없다' })
  .refine(noNul, { message: NUL_MESSAGE });

/**
 * LLM 등록 (FR-1100·1104). **주소는 판정한 모양으로 바꿔 받는다** — 화면과 서버가 같은 함수(`normalizeLlmBaseUrl`)를 쓴다.
 * API 키는 없어도 된다. 빈 키는 없는 키다. **키에 줄바꿈을 막는다** — 요청 머리말(`Authorization`)에 들어간다.
 */
export const createLlmProviderDto = z.object({
  name: llmNameSchema,
  baseUrl: z.string().transform((v, ctx) => {
    const r = normalizeLlmBaseUrl(v);
    if (!r.ok) {
      ctx.addIssue({ code: 'custom', message: r.reason });
      return z.NEVER;
    }
    return r.url;
  }),
  model: z.string().trim().min(1).max(LLM_LIMITS.modelMaxChars).refine(noNul, { message: NUL_MESSAGE }),
  // **보이는 ASCII만** (검토 반영 — 코드 리뷰 15). 요청 머리말(`Authorization`)에 들어가므로 줄바꿈은 머리말 주입이 되고, 폭 없는
  // 빈칸·한글·NUL이 섞인 키는 요청이 나가기도 전에 막혀 모든 질문이 "닿지 않는다"로 오진된다 — 키는 다시 볼 수 없어 찾을 수도 없다
  apiKey: z
    .string()
    .max(LLM_LIMITS.apiKeyMaxChars)
    .nullish()
    .transform((v) => (v && v.trim() ? v.trim() : null))
    .refine((v) => v === null || /^[\x21-\x7e]+$/.test(v), { message: 'API 키는 빈칸 없는 영문·숫자·기호(보이는 ASCII)여야 한다' }),
});
export type CreateLlmProviderDto = z.infer<typeof createLlmProviderDto>;

/** 지시문 — 시스템 프롬프트 (FR-1125·1129) */
const promptContentSchema = z.string().trim().min(1).max(LLM_LIMITS.promptMaxChars).refine(noNul, { message: NUL_MESSAGE });

export const createLlmPromptDto = z.object({
  name: llmNameSchema,
  content: promptContentSchema,
});
export type CreateLlmPromptDto = z.infer<typeof createLlmPromptDto>;

export const updateLlmPromptDto = z
  .object({
    name: llmNameSchema.optional(),
    content: promptContentSchema.optional(),
  })
  // **빈 몸통을 거부한다** — 템플릿 고치기와 같은 판단
  .refine((v) => v.name !== undefined || v.content !== undefined, { message: '바꿀 것을 하나는 줘야 한다' });
export type UpdateLlmPromptDto = z.infer<typeof updateLlmPromptDto>;

/**
 * 질문 (FR-1110·1116·1127). `promptId`는 **새 대화에서만** 받는다 — 이어 묻는 대화의 지시문은 시작할 때 복사된 것이다.
 */
export const llmAskDto = z
  .object({
    providerId: z.uuid(),
    conversationId: z.uuid().optional(),
    promptId: z.uuid().optional(),
    question: z.string().trim().min(1).max(LLM_LIMITS.questionMaxChars).refine(noNul, { message: NUL_MESSAGE }),
  })
  .refine((v) => !(v.conversationId && v.promptId), {
    message: '지시문은 새 대화를 시작할 때만 고른다',
    path: ['promptId'],
  });
export type LlmAskDto = z.infer<typeof llmAskDto>;

/** 일반 사용자가 보는 LLM — 이름과 모델만 (FR-1107) */
export type LlmProviderView = { id: string; name: string; model: string };

/** 관리 화면이 보는 LLM. **키는 있다·없다만** (FR-1102) */
export type LlmProviderAdminView = LlmProviderView & {
  baseUrl: string;
  hasKey: boolean;
  createdByName: string;
  createdAt: string;
};

/** 연결 확인 (FR-1105) */
export type LlmCheckView = { ok: true; models: string[]; modelFound: boolean } | { ok: false; message: string };

export type LlmPromptView = { id: string; name: string; content: string; updatedAt: string };

export type LlmConversationSummary = {
  id: string;
  title: string;
  /** 지운 LLM이면 null이다 (FR-1101) */
  providerId: string | null;
  providerName: string | null;
  promptName: string | null;
  pinned: boolean;
  updatedAt: string;
  /** 고정한 대화는 null — 풀 때까지 지워지지 않는다 (FR-1133) */
  expiresAt: string | null;
};

export type LlmMessageView = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  status: LlmStreamStatus;
  createdAt: string;
};

export type LlmConversationView = LlmConversationSummary & { systemPrompt: string | null; messages: LlmMessageView[] };

/** 목록 + 이 사람이 지켜야 할 상한 (G절). 상한은 운영 설정의 값이다 */
export type LlmConversationList = {
  items: LlmConversationSummary[];
  limits: { retentionDays: number; conversationMax: number; pinnedMax: number };
};
