-- P5 (FR-627). Phase 2가 넘긴 두 가지를 반입 전에 정리한다.
--
-- ① 상태·종류 컬럼에 CHECK 제약
-- ② page_versions 수정 금지
--
-- 왜 지금인가. 폐쇄망에 들어가면 마이그레이션 하나에도 반입 절차가 붙는다.
-- **제약은 늦게 넣을수록 비싸다** — 이미 어긋난 행이 있으면 넣을 수조차 없다.

-- ── ① 값 집합 제약 ────────────────────────────────────────────────────────
--
-- 값 집합은 `packages/shared/src/constants.ts`가 정본이고 zod가 입구에서 막는다.
-- 그런데 **입구가 하나뿐이라는 보장이 없다.** 마이그레이션·시드·psql·관리자의 손이
-- 모두 같은 테이블에 쓴다. 코드를 안 거치고 들어온 값은 조용히 살아 있다가
-- 권한 판정을 엉뚱하게 만든다 — `kind`가 'Team'이면 팀 스페이스로도, 개인
-- 스페이스로도 취급되지 않는다.
--
-- 새 값이 필요해지면 **이 제약을 고치는 마이그레이션을 쓴다.** 그것이 의도된 마찰이다.

ALTER TABLE users  ADD CONSTRAINT users_role_chk   CHECK (role   IN ('root', 'admin', 'member'));
ALTER TABLE users  ADD CONSTRAINT users_status_chk CHECK (status IN ('pending', 'active'));
ALTER TABLE spaces ADD CONSTRAINT spaces_kind_chk   CHECK (kind   IN ('personal', 'team'));
ALTER TABLE spaces ADD CONSTRAINT spaces_status_chk CHECK (status IN ('active', 'suspended'));
ALTER TABLE space_members ADD CONSTRAINT space_members_role_chk CHECK (role IN ('owner', 'editor', 'viewer'));

-- ── ② page_versions는 고쳐 쓰지 않는다 ────────────────────────────────────
--
-- CLAUDE.md 6절: "`page_versions`는 append-only. 수정은 새 버전 추가".
--
-- **UPDATE만 막고 DELETE는 막지 않는다.** 이 규칙이 지키려는 것은 "이미 저장된 버전의
-- 내용이 나중에 달라지지 않는다"다. 그것을 깨는 것은 UPDATE다. DELETE는 성격이 다르다 —
-- 페이지가 물리 삭제되면(`pnpm trash:purge`, 보존 기간 경과) 그 버전들도 FK CASCADE로
-- 함께 사라져야 하고, 그것이 맞다. 여기서 DELETE를 막으면 정리 배치가 돌지 않는다.
--
-- `audit_events`와 다르게 대하는 이유가 이것이다. 감사로그는 **대상이 사라져도 남아야**
-- 하는 기록이고, 페이지 버전은 **대상에 딸린 내용**이다. 둘의 append-only는 같은 말이
-- 아니다 (0005_audit_retention.sql의 판단과 짝을 이룬다).

CREATE OR REPLACE FUNCTION page_versions_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'page_versions는 고쳐 쓰지 않는다. 새 버전을 추가한다 (CLAUDE.md 6절)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER page_versions_no_update
  BEFORE UPDATE ON page_versions
  FOR EACH ROW EXECUTE FUNCTION page_versions_no_update();
