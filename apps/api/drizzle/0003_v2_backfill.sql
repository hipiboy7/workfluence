-- 프로토타입 v1 → v2 데이터 이행 (docs/prompts/prototype-v2.md)
-- 1) v1의 'admin' 역할은 시스템 관리자 root가 된다
UPDATE users SET role = 'root' WHERE role = 'admin';
--> statement-breakpoint
-- 2) 기본 카테고리 '일반' (생성자는 가장 먼저 만들어진 root)
INSERT INTO space_categories (name, created_by)
SELECT '일반', id FROM users WHERE role = 'root' ORDER BY created_at LIMIT 1
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 3) 카테고리 없는 기존 스페이스는 '일반'으로
UPDATE spaces SET category_id = (SELECT id FROM space_categories WHERE name = '일반' LIMIT 1) WHERE category_id IS NULL;
--> statement-breakpoint
-- 4) 기존 스페이스 생성자는 Crew owner
INSERT INTO space_members (space_id, user_id, role, added_by)
SELECT id, created_by, 'owner', created_by FROM spaces
ON CONFLICT DO NOTHING;
