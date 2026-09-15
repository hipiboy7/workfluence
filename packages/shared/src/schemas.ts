import { z } from 'zod';
import {
  ASSIGNABLE_MEMBER_ROLES,
  PASSWORD_POLICY,
  ROLES,
  SPACE_KINDS,
  SPACE_MEMBER_ROLES,
  SPACE_STATUSES,
  USER_STATUSES,
} from './constants';
import { validateDocument, type DocNode } from './document';
import { checkPasswordPolicy } from './permissions';

/** API 요청·응답 계약. 서버(zod 파이프)와 클라이언트(타입)가 같은 정의를 쓴다. */

export const documentSchema = z
  .unknown()
  .superRefine((v, ctx) => {
    const r = validateDocument(v);
    if (!r.ok) ctx.addIssue({ code: 'custom', message: `본문 검증 실패: ${r.errors.join('; ')}` });
  })
  .transform((v) => v as DocNode);

export const passwordSchema = z.string().superRefine((pw, ctx) => {
  for (const reason of checkPasswordPolicy(pw, PASSWORD_POLICY)) ctx.addIssue({ code: 'custom', message: reason });
});

export const usernameSchema = z.string().trim().regex(/^[a-z0-9._-]{2,64}$/, '소문자·숫자·._- 2~64자');
// zod 4의 z.email()은 검증만 하므로 정규화(trim·소문자)를 먼저 하고 파이프한다. TLD는 2자 이상이어야 통과한다
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('올바른 email 형식이 아니다'));
export const displayNameSchema = z.string().trim().min(1).max(100);

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
  createdAt: string;
};

export type MeView = {
  id: string;
  username: string;
  displayName: string;
  role: (typeof ROLES)[number];
  mustChangePassword: boolean;
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
