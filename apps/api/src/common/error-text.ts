/**
 * 로그에 가는 **오류 문장** (7절 로그 규칙). 로그에 오류를 적는 곳은 전부 이것을 쓴다 — `String(e)`·`e.message`를 그대로 싣지 않는다.
 *
 * **drizzle의 오류 문장(`Failed query: … params: …`)에는 질의의 매개변수가 그대로 있다** — 문서 본문·질문·지시문이 로그로 샌다.
 * 그 문장은 버리고 원인(PostgreSQL 오류)의 **코드와 문장만** 싣는다. pg의 `detail`(값이 들어간다)도 싣지 않는다. 문장이 길면 줄인다.
 *
 * **PostgreSQL의 문장에도 값이 들어가는 부류가 있다** — 데이터 예외(SQLSTATE 22)는 받은 값을 따옴표로 싣는다
 * (`22P02 invalid input syntax for type uuid: "…"`, `22003 value "…" is out of range for type integer`). 그 부류는 따옴표 안을 가린다.
 * 다른 부류(무결성 23·이름 42 등)의 문장은 표·열·제약의 이름만 싣고 값은 `detail`에 둔다 — 실제 PostgreSQL로 시험한다
 * (`error-text.integration.spec.ts`, 종료 루틴 자체 점검 1).
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

/** 데이터 예외(SQLSTATE 22) — 문장이 받은 값을 따옴표로 싣는다 */
const DATA_EXCEPTION = /^22/;

/** PostgreSQL의 문장 — 데이터 예외면 첫 따옴표부터 마지막 따옴표까지를 가린다(값 안에 따옴표가 있어도 새지 않게) */
function pgMessage(code: string, message: string): string {
  return DATA_EXCEPTION.test(code) ? message.replace(/"[\s\S]*"/, '"…"') : message;
}

export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return cut(String(e));
  const cause = causeOf(e);
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const message = typeof cause?.message === 'string' ? pgMessage(code, cause.message) : '';
  const parts = [code, message].filter(Boolean);
  if (parts.length) return cut(parts.join(' '));
  if (DRIZZLE_FAILED.test(e.message)) return `${e.name} (DB 질의 실패 — 문장은 싣지 않는다)`;
  return cut(`${e.name}: ${e.message}`);
}

/** drizzle의 질의 오류인가 — 그 문장(`e.message`)에는 매개변수가 있다. 문장을 그대로 싣던 자리(기동 실패)가 가른다 */
export function isQueryError(e: unknown): boolean {
  return e instanceof Error && DRIZZLE_FAILED.test(e.message);
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
