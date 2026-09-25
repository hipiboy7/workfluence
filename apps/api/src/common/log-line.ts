import type { LogEvent } from '@workfluence/shared';

/**
 * 로그 한 줄의 모양 (P11_설계서_Ops D.4, FR-1214) — **안정된 event 코드**, 식별자 필드, 사람을 위한 문장.
 *
 * Nest `Logger`에 이 모양을 넘기면 공통 로거(`logger.ts`)가 필드로 펼친다: `{"event":"llm.ask_failed","providerId":…,"msg":"…"}`.
 * **문장에 id를 섞지 않는다** — `(page=…)`로 적던 것은 필드로 옮긴다. 오류는 `err`로 넘긴다 — 로거가 `errorText`(`error` 수준이면
 * `errorStack`까지)로 적는다. 오류 문장을 그대로 싣지 않는다(7절)
 */
export type LogLine = {
  readonly kind: 'wf.log-line';
  readonly event: LogEvent;
  readonly msg: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly err?: unknown;
};

export function logLine(event: LogEvent, msg: string, fields: Record<string, unknown> = {}, err?: unknown): LogLine {
  return { kind: 'wf.log-line', event, msg, fields, ...(err === undefined ? {} : { err }) };
}

export function isLogLine(v: unknown): v is LogLine {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'wf.log-line';
}
