import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * 데이터 모델. 전체 그림은 docs/설계서_Architecture.md 3.1절이 단일 출처이고,
 * 각 Phase가 자기 테이블의 마이그레이션을 추가한다.
 *
 * 공통 규약 (설계서_Architecture 3.2절)
 * - 시각은 UTC timestamptz. 표시만 KST로 변환한다
 * - 식별자는 uuid
 * - 삭제는 deleted_at soft delete
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * 사용자 (P1_설계서_Auth 1절).
 *
 * 로컬 계정과 IdP 계정이 **같은 테이블**에 수렴한다. 구분은 어느 열이 차 있는가로 한다.
 * - 로컬 계정: password_hash 있음, oidc_sub 없음
 * - IdP 계정:  oidc_sub 있음, password_hash 없음 (FR-217 — 비밀번호 로그인을 할 수 없다)
 * 둘 다 비어 있는 행은 **어느 방법으로도 로그인할 수 없는 유령 계정**이라 CHECK로 막는다.
 *
 * status는 pending|active 둘뿐이다. '잠김'은 저장하지 않고 locked_until로 파생한다 —
 * 잠금은 시간이 지나면 저절로 풀리는 상태라서, 저장해 두면 실제와 어긋나는 순간이 생긴다.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    email: text('email'),
    passwordHash: text('password_hash'),
    /** IdP의 sub 클레임. 사용자 키다 (FR-215). preferred_username은 바뀔 수 있어 쓰지 않는다 */
    oidcSub: text('oidc_sub'),
    role: text('role').notNull().default('member'),
    status: text('status').notNull().default('pending'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username),
    uniqueIndex('users_email_uq').on(t.email),
    uniqueIndex('users_oidc_sub_uq').on(t.oidcSub),
    check('users_login_method_chk', sql`${t.passwordHash} IS NOT NULL OR ${t.oidcSub} IS NOT NULL`),
  ],
);

/**
 * 서버측 세션 (FR-220). connect-pg-simple이 쓰는 표준 열 구성이다.
 * 스키마를 여기에 두는 이유: 마이그레이션이 이 테이블도 관리해야 운영에서 손으로 만들 일이 없다.
 */
export const sessions = pgTable(
  'sessions',
  {
    sid: text('sid').primaryKey(),
    sess: jsonb('sess').notNull(),
    expire: timestamp('expire', { withTimezone: true, precision: 6 }).notNull(),
  },
  (t) => [index('sessions_expire_idx').on(t.expire)],
);

/**
 * 감사로그 (FR-235~239). **append-only** — 마이그레이션이 UPDATE/DELETE를 트리거로 막는다.
 * 운영에서는 앱 DB 계정 권한으로도 막는다. 두 겹인 이유는 개발에서 계정을 나누지 않기 때문이다.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    action: text('action').notNull(),
    actorId: uuid('actor_id'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    detail: jsonb('detail'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_events_created_idx').on(t.createdAt), index('audit_events_actor_idx').on(t.actorId)],
);

/** 운영 조절값 (CLAUDE.md 5절 세 번째 분류). 관리 화면은 Phase 4. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  /** Phase 1에서 users가 생겨 FK를 걸었다 (P0_설계서 13절 인계) */
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
