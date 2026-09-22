-- 감사로그 보존 정리를 위한 **좁은 예외** (P4_설계서_Admin FR-540, scope-definition 위험 7).
--
-- `audit_events`는 append-only다 (CLAUDE.md 6절). 그런데 보존 기간이 지난 것은 지워야
-- 한다 — 그 둘을 같이 지키려면 "아무도 못 지운다"가 아니라 **"정해진 방법으로만 지운다"**여야 한다.
--
-- 그래서 트리거를 없애지 않고 조건을 단다. DELETE는 아래 둘을 **모두** 만족할 때만 통과한다.
--   ① 이 트랜잭션이 `wf.audit_purge = on`을 명시했다 (실수로 지울 수 없다)
--   ② 지우려는 행이 `wf.audit_purge_before`보다 **이전**이다 (최근 기록은 그 방법으로도 못 지운다)
-- UPDATE는 여전히 **무조건** 막는다. 고치는 것은 어떤 경우에도 허용하지 않는다.
--
-- 두 설정값은 `set_config(..., true)`로 **트랜잭션 안에서만** 산다. 커밋되면 사라진다.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
DECLARE
  purging text := current_setting('wf.audit_purge', true);
  before_ts text := current_setting('wf.audit_purge_before', true);
BEGIN
  IF TG_OP = 'DELETE'
     AND purging = 'on'
     AND before_ts IS NOT NULL
     AND OLD.created_at < before_ts::timestamptz THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events는 append-only다 (시도: %)', TG_OP;
END;
$$ LANGUAGE plpgsql;
