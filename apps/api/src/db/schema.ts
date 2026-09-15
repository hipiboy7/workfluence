import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * 데이터 모델 (프로토타입). 시각은 전부 UTC timestamptz (CLAUDE.md 6절).
 * - page_versions는 append-only: 수정은 새 버전 추가, pages.current_version_no만 이동.
 * - audit_events는 append-only.
 * - 삭제는 soft delete(deleted_at).
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash'),
    role: text('role').notNull().default('member'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_username_uq').on(t.username)],
);

export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('spaces_key_uq').on(t.key)],
);

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
    /** 현재 버전의 평문. 검색 전용 파생 데이터 — 언제든 재생성 가능 */
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

export type UserRow = typeof users.$inferSelect;
export type SpaceRow = typeof spaces.$inferSelect;
export type PageRow = typeof pages.$inferSelect;
export type PageVersionRow = typeof pageVersions.$inferSelect;
