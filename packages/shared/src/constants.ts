/**
 * 설계상 고정값 (CLAUDE.md 5절). 바꾸면 데이터·마이그레이션을 다시 만들어야 하는 것만 여기에 둔다.
 * 환경별 값은 .env(env.ts), 운영 조절값은 Phase 4부터 DB settings.
 */

/** 시스템 역할. 프로토타입은 2단계만 둔다. 스페이스별 권한은 Phase 4. */
export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** 문서(ProseMirror JSON) 스키마 버전. 노드·마크 허용 목록이 바뀌면 올린다. */
export const DOCUMENT_SCHEMA_VERSION = 1;

/** 감사 이벤트 종류 (CLAUDE.md 6절 감사로그 대상) */
export const AUDIT_ACTIONS = [
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'user.create',
  'space.create',
  'space.update',
  'space.delete',
  'page.create',
  'page.update',
  'page.move',
  'page.delete',
  'page.restore',
  'page.version.restore',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 페이지 트리 최대 깊이. 무한 중첩은 이동·경로 계산 비용을 키운다. */
export const PAGE_TREE_MAX_DEPTH = 10;

/** 스페이스 키 규칙: 대문자 영숫자 2~10자, 첫 글자는 영문. URL 경로 세그먼트로 쓴다. */
export const SPACE_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/** 상태 변경 요청에 요구하는 CSRF 헤더 (CLAUDE.md 7절). 값이 아니라 헤더의 존재가 방어다. */
export const CSRF_HEADER = 'x-workfluence-request';
export const CSRF_HEADER_VALUE = '1';

/** 로컬 계정 비밀번호 기본 정책 (CLAUDE.md 7절 기본값. 사내 정책 확인 후 조정) */
export const PASSWORD_POLICY = {
  minLength: 12,
  minCharClasses: 3,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
} as const;
