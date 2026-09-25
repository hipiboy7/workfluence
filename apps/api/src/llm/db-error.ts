/**
 * DB 오류를 로그 한 줄로 (P10_설계서_Llm FR-1117, 7절 로그 규칙).
 *
 * **PostgreSQL의 오류 코드와 문장만** 싣는다. drizzle의 오류 문장(`Failed query: … params: …`)에는 질의의 매개변수가 그대로
 * 들어 있어, 대화 저장이 실패한 자리라면 **질문과 답이 로그로 샌다.** pg의 `detail`(값이 들어간다)도 싣지 않는다.
 * 운영에서 마이그레이션 전에 앱이 먼저 뜨면 이 줄이 `42P01 relation "llm_conversations" does not exist`로 까닭을 말한다 —
 * P10 컨테이너 확인에서 드러났다.
 */
export function dbErrorText(e: unknown): string {
  const cause = e instanceof Error ? (e.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  const parts = [typeof cause?.code === 'string' ? cause.code : '', typeof cause?.message === 'string' ? cause.message : ''].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return e instanceof Error ? e.name : typeof e;
}
