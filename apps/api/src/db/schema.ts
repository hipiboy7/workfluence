import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 데이터 모델 (P0_설계서_Foundation 3.2절).
 * Phase 0은 `settings` 하나만 만든다. 전체 모델은 docs/설계서_Architecture.md 3.1절에 그려 두고
 * 각 Phase에서 마이그레이션을 추가한다.
 *
 * 공통 규약 (설계서_Architecture 3.2절)
 * - 시각은 UTC timestamptz. 표시만 KST로 변환한다
 * - 식별자는 uuid
 * - 삭제는 deleted_at soft delete
 */

/** 운영 조절값 (CLAUDE.md 5절 세 번째 분류). 관리 화면은 Phase 4. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  /** Phase 1에서 users 생성 후 FK 제약을 추가한다 (P0_설계서 13절 인계) */
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SettingRow = typeof settings.$inferSelect;
