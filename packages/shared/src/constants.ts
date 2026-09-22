/**
 * 설계상 고정값 (CLAUDE.md 5절). 바꾸면 데이터·마이그레이션을 다시 만들어야 하는 것만 여기에 둔다.
 * 환경별 값은 .env(env.ts), 운영 조절값은 Phase 4부터 DB settings.
 */

/** 시스템 역할. root ⊃ admin ⊃ member (docs/prompts/prototype-v2.md 2절 12번) */
export const ROLES = ['root', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** 사용자 상태. '잠김'은 저장하지 않고 locked_until로 파생한다 */
export const USER_STATUSES = ['pending', 'active'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SPACE_KINDS = ['personal', 'team'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

export const SPACE_STATUSES = ['active', 'suspended'] as const;
export type SpaceStatus = (typeof SPACE_STATUSES)[number];

/** Crew 역할. owner는 생성자에게 자동 부여, 나머지는 owner·admin이 지정 */
export const SPACE_MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const;
export type SpaceMemberRole = (typeof SPACE_MEMBER_ROLES)[number];
export const ASSIGNABLE_MEMBER_ROLES = ['editor', 'viewer'] as const;

/** 문서(ProseMirror JSON) 스키마 버전. 노드·마크 허용 목록이 바뀌면 올린다. */
export const DOCUMENT_SCHEMA_VERSION = 1;

/** 감사 이벤트 종류 (CLAUDE.md 6절 감사로그 대상) */
export const AUDIT_ACTIONS = [
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'auth.password.change',
  'auth.id.recover',
  'auth.password.recover',
  'user.signup',
  'user.create',
  'user.approve',
  'user.unlock',
  'user.password.reset',
  'user.sessions.terminate',
  'user.role.change',
  'category.create',
  'space.create',
  'space.update',
  'space.status.change',
  'space.delete',
  'space.member.add',
  'space.member.role.change',
  'space.member.remove',
  'page.create',
  'page.update',
  'page.move',
  'page.delete',
  'page.restore',
  'page.version.restore',
  'attachment.upload',
  'attachment.download',
  'attachment.delete',
  'comment.create',
  'comment.update',
  'comment.delete',
  'page.restore.trash',
  'space.restore',
  'trash.purge',
  'label.attach',
  'label.detach',
  'category.update',
  'category.delete',
  'settings.update',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 페이지 트리 최대 깊이. 무한 중첩은 이동·경로 계산 비용을 키운다. */
export const PAGE_TREE_MAX_DEPTH = 10;

/** 상태 변경 요청에 요구하는 CSRF 헤더 (CLAUDE.md 7절). 값이 아니라 헤더의 존재가 방어다. */
export const CSRF_HEADER = 'x-workfluence-request';
export const CSRF_HEADER_VALUE = '1';

/** 로컬 계정 비밀번호 정책 (사용자 결정 2026-09-15: 8자·2종. 잠금 5회/15분 유지) */
export const PASSWORD_POLICY = {
  minLength: 8,
  minCharClasses: 2,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
} as const;

/** 임시(초기화) 비밀번호 길이. 생성 규칙은 security.ts */
export const TEMP_PASSWORD_LENGTH = 12;


/**
 * 첨부로 받을 수 있는 확장자 (P4_설계서_Admin FR-521).
 *
 * **판정 규칙(`attachments/domain/upload.ts`·`signature.ts`)이 있는 것만 여기 있다.**
 * 관리자가 이 목록 밖의 확장자를 켤 수는 없다 — 규칙 없는 확장자를 허용하면 내용 검사를
 * 지나치게 되고, 그것이 곧 "이름만 바꾼 파일"이 들어오는 길이다.
 */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'csv', 'md', 'zip', 'docx', 'xlsx', 'pptx', 'hwp',
] as const;

/**
 * 관리·목록 화면이 한 번에 받아 오는 최대 건수 (P4_설계서_Admin FR-537).
 *
 * 300명 규모에서 이 목록들이 수천을 넘지 않으므로 페이지네이션 대신 **상한 + 검색**으로
 * 간다. 넘기 시작하면 그때 만든다 — 지금 만들면 쓰이지 않는 코드가 된다.
 */
export const LIST_PAGE_LIMIT = 200;

/** settings 테이블 키 */
export const SETTINGS_KEYS = {
  contactInfo: 'contact_info',
  /** 운영 정책값 한 덩어리 (P4_설계서_Admin FR-520). 키마다 행을 두지 않는 이유는 한 번에 읽고 한 번에 캐시하기 위해서다 */
  policy: 'policy',
} as const;

/** 공개 엔드포인트 요청 제한 (IP 기준). 계정 열거·무차별 대입 완화 */
export const RATE_LIMITS = {
  signup: { max: 5, windowSec: 600 },
  findId: { max: 5, windowSec: 60 },
  recoverPassword: { max: 3, windowSec: 600 },
  login: { max: 20, windowSec: 60 },
} as const;
