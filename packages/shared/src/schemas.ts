import { z } from 'zod';
import { PASSWORD_POLICY, ROLES, SPACE_KEY_PATTERN } from './constants';
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

export const passwordSchema = z
  .string()
  .superRefine((pw, ctx) => {
    for (const reason of checkPasswordPolicy(pw, PASSWORD_POLICY)) ctx.addIssue({ code: 'custom', message: reason });
  });

export const loginDto = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginDto = z.infer<typeof loginDto>;

export const createUserDto = z.object({
  username: z.string().trim().regex(/^[a-z0-9._-]{2,64}$/, '소문자·숫자·._- 2~64자'),
  displayName: z.string().trim().min(1).max(100),
  password: passwordSchema,
  role: z.enum(ROLES),
});
export type CreateUserDto = z.infer<typeof createUserDto>;

export const createSpaceDto = z.object({
  key: z.string().trim().regex(SPACE_KEY_PATTERN, '대문자 영숫자 2~10자, 첫 글자는 영문'),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
});
export type CreateSpaceDto = z.infer<typeof createSpaceDto>;

// partial()은 zod 4에서 default를 유지하므로(description이 ''로 채워짐) 명시적으로 정의한다
export const updateSpaceDto = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
});
export type UpdateSpaceDto = z.infer<typeof updateSpaceDto>;

export const createPageDto = z.object({
  spaceId: z.string().uuid(),
  parentId: z.string().uuid().nullable().default(null),
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
  parentId: z.string().uuid().nullable(),
  position: z.number().int().min(0),
});
export type MovePageDto = z.infer<typeof movePageDto>;

export const searchQueryDto = z.object({
  q: z.string().trim().min(1).max(200),
  spaceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQueryDto = z.infer<typeof searchQueryDto>;

/** 응답 타입 (클라이언트용) */
export type UserView = { id: string; username: string; displayName: string; role: (typeof ROLES)[number]; createdAt: string };
export type SpaceView = { id: string; key: string; name: string; description: string; createdAt: string; updatedAt: string };
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
export type SearchHit = { pageId: string; spaceId: string; spaceKey: string; title: string; snippet: string; updatedAt: string };
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
