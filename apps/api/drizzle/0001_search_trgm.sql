-- 한글 부분 일치 검색용 pg_trgm (contrib, 공식 이미지 포함). pg_bigm 전환은 CLAUDE.md 보류 2.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pages_title_trgm_idx ON pages USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pages_search_text_trgm_idx ON pages USING gin (search_text gin_trgm_ops);
--> statement-breakpoint
-- 감사로그 append-only: 앱 계정의 UPDATE/DELETE는 운영 DB 권한(GRANT)으로 막는다. 여기서는 트리거로 이중 방어.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
