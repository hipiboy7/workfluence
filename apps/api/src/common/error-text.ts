/**
 * 로그에 가는 **오류 문장** (7절 로그 규칙). 로그에 오류를 적는 곳은 전부 이것을 쓴다 — `String(e)`·`e.message`를 그대로 싣지 않는다.
 *
 * **drizzle의 오류 문장(`Failed query: … params: …`)에는 질의의 매개변수가 그대로 있다** — 문서 본문·질문·지시문이 로그로 샌다.
 * 그 문장은 버리고 원인(PostgreSQL 오류)의 **코드와 문장만** 싣는다. pg의 `detail`(값이 들어간다)도 싣지 않는다. 문장이 길면 줄인다.
 *
 * P10 검토에서 드러났고(보안 검토 3 · 컨테이너 확인), 사용자의 로깅 검토 요청(2026-09-25)이 같은 자리를 짚었다 —
 * 처리되지 않은 예외는 Nest가 이 로거로 넘기는데 예전에는 스택이 버려지고 문장이 통째로 갔다.
 */
const MAX_TEXT = 500;
const DRIZZLE_FAILED = /^Failed query:/;

type Cause = { code?: unknown; message?: unknown };

function causeOf(e: Error): Cause | undefined {
  const c = e.cause;
  return typeof c === 'object' && c !== null ? (c as Cause) : undefined;
}

function cut(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
}

export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return cut(String(e));
  const cause = causeOf(e);
  const parts = [typeof cause?.code === 'string' ? cause.code : '', typeof cause?.message === 'string' ? cause.message : ''].filter(Boolean);
  if (parts.length) return cut(parts.join(' '));
  if (DRIZZLE_FAILED.test(e.message)) return `${e.name} (DB 질의 실패 — 문장은 싣지 않는다)`;
  return cut(`${e.name}: ${e.message}`);
}

/** 호출 위치만 남긴 스택 — 첫 줄(오류 문장)을 `errorText`로 바꾼다. 문장이 여러 줄이어도(`params:`) 호출 위치(`at …`) 줄만 남긴다 */
export function errorStack(e: unknown): string | undefined {
  if (!(e instanceof Error) || !e.stack) return undefined;
  return scrubStack(e.stack, errorText(e));
}

/** 문자열로 온 스택에서 문장 줄을 걷어 낸다 */
export function scrubStack(stack: string, head: string): string {
  const frames = stack.split('\n').filter((l) => /^\s+at /.test(l));
  return [head, ...frames].join('\n');
}

/** 문자열로 온 문장 — drizzle 문장이면 버린다 */
export function scrubMessage(message: string): string {
  return DRIZZLE_FAILED.test(message) ? '(DB 질의 실패 — 문장은 싣지 않는다)' : message;
}
