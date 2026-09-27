-- P13 (P13_설계서_Readiness E절). 손으로 쓴다 (보류 17).

-- ── 계정 정지 (FR-1440) ───────────────────────────────────────────────────
--
-- 사용자 상태에 정지(suspended)를 더한다 — 퇴사자 처리. 로그인하지 못하고, 내용·Crew 소속·감사 기록은 남는다.
-- 상태 값은 packages/shared의 USER_STATUSES와 같게 둔다(그 목록을 늘리면 이 CHECK도 고친다).
-- 기존 행은 모두 pending·active라 그대로 지난다.
ALTER TABLE users DROP CONSTRAINT users_status_chk;
ALTER TABLE users ADD CONSTRAINT users_status_chk CHECK (status IN ('pending', 'active', 'suspended'));
