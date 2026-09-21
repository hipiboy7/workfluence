import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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

/** 스페이스 분류 (P2_설계서_Page 1절). 이름은 유일하다 */
export const spaceCategories = pgTable(
  'space_categories',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('space_categories_name_uq').on(t.name)],
);

/**
 * 스페이스 (FR-300~314).
 * `kind`: personal|team, `status`: active|suspended. 접근 판정은 shared의 spaceAccess()가 한다.
 */
export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** WF + 6자. 사람이 부르는 이름과 별개로 변하지 않는 식별자 */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    kind: text('kind').notNull().default('team'),
    status: text('status').notNull().default('active'),
    categoryId: uuid('category_id').references(() => spaceCategories.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedBy: uuid('suspended_by'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('spaces_key_uq').on(t.key), index('spaces_kind_status_idx').on(t.kind, t.status)],
);

/** Crew (FR-301, FR-302). 개인 스페이스는 이 표를 쓰지 않는다 */
export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull().default('viewer'),
    addedBy: uuid('added_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.userId] }), index('space_members_user_idx').on(t.userId)],
);

/**
 * 페이지 (FR-320~334).
 * `current_version_no`가 정본 버전을 가리킨다. `search_text`는 **파생 데이터**라 언제든 재생성한다.
 */
export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    parentId: uuid('parent_id'),
    title: text('title').notNull(),
    position: integer('position').notNull().default(0),
    currentVersionNo: integer('current_version_no').notNull().default(0),
    /** 현재 버전의 평문. 검색 전용 파생 데이터 (Phase 3에서 인덱스를 건다) */
    searchText: text('search_text').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('pages_space_parent_idx').on(t.spaceId, t.parentId, t.position)],
);

/**
 * 페이지 버전 (FR-324). **append-only** — 수정도 복원도 새 행이다.
 * (page_id, version_no) 유일 제약이 동시 저장의 번호 충돌을 최종적으로 막는다.
 */
export const pageVersions = pgTable(
  'page_versions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id),
    versionNo: integer('version_no').notNull(),
    title: text('title').notNull(),
    contentJson: jsonb('content_json').notNull(),
    contentText: text('content_text').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('page_versions_page_no_uq').on(t.pageId, t.versionNo)],
);

/**
 * 첨부 (P3_설계서_Content 3절, FR-410~419).
 * 파일은 내용 SHA-256으로 한 벌만 저장하고 이 표는 **메타데이터**다. 같은 내용을 여러 페이지에
 * 올리면 행만 늘어난다.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id),
    /** 내용 해시. **파일 이름이기도 하다** — 사용자 입력은 경로에 닿지 않는다 (FR-412) */
    sha256: text('sha256').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('attachments_page_idx').on(t.pageId), index('attachments_sha_idx').on(t.sha256)],
);

/** 댓글 (FR-420~424). 본문도 ProseMirror JSON이다 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id),
    /** 대댓글은 한 단계까지 (FR-421) */
    parentId: uuid('parent_id'),
    bodyJson: jsonb('body_json').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('comments_page_idx').on(t.pageId, t.createdAt)],
);

/** 라벨 (FR-425). 테이블만 만들고 화면은 Phase 4 */
export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('labels_name_uq').on(t.name)],
);

export const pageLabels = pgTable(
  'page_labels',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.labelId] })],
);

/** 운영 조절값 (CLAUDE.md 5절 세 번째 분류). 관리 화면은 Phase 4. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  /** Phase 1에서 users가 생겨 FK를 걸었다 (P0_설계서 13절 인계) */
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AttachmentRow = typeof attachments.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type SpaceRow = typeof spaces.$inferSelect;
export type SpaceCategoryRow = typeof spaceCategories.$inferSelect;
export type SpaceMemberRow = typeof spaceMembers.$inferSelect;
export type PageRow = typeof pages.$inferSelect;
export type PageVersionRow = typeof pageVersions.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
