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

/** settings 테이블 키 */
export const SETTINGS_KEYS = {
  contactInfo: 'contact_info',
} as const;

/** 공개 엔드포인트 요청 제한 (IP 기준). 계정 열거·무차별 대입 완화 */
export const RATE_LIMITS = {
  signup: { max: 5, windowSec: 600 },
  findId: { max: 5, windowSec: 60 },
  recoverPassword: { max: 3, windowSec: 600 },
  login: { max: 20, windowSec: 60 },
} as const;
