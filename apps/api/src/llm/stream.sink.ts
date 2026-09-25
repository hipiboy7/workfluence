import { encodeLlmEvent, type LlmStreamEvent } from '@workfluence/shared';

/**
 * 흐름을 받는 쪽 (P10_설계서_Llm D.1). 질문 중계(`ask.service.ts`)는 이것만 안다 — HTTP 응답을 모른다. 시험은 배열에 담는다.
 */
export interface LlmSink {
  write(event: LlmStreamEvent): void;
  /** 끝낸다. 두 번 불러도 된다 */
  close(): void;
  /** 받는 쪽이 끊기면(창을 닫음·새로 고침) 부른다 — 중계는 LLM 요청을 끊고 거기까지를 저장한다 */
  onGone(listener: () => void): void;
}

/** 이 흐름이 쓰는 만큼의 HTTP 응답 — Express `Response`, 시험은 가짜 */
export type ResponseLike = {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): unknown;
  on(event: 'close', listener: () => void): unknown;
};

/**
 * NDJSON으로 흘려보낸다 (D.1).
 *
 * - **`X-Accel-Buffering: no`** — nginx가 이 응답만 버퍼링하지 않는다. `deploy/nginx.conf`에 위치 블록을 늘리지 않는다(판단을 한 곳에)
 * - 머리말을 **먼저** 보낸다 — LLM 서버가 첫 글자를 내기 전에도 브라우저는 연결이 열렸음을 안다
 * - `heartbeatMs` 동안 아무것도 안 썼으면 `ping` 한 줄 (FR-1115) — 프록시가 조용한 연결을 끊지 않게
 * - 응답의 `close`가 **우리가 끝내기 전에** 오면 받는 쪽이 끊긴 것이다
 */
export class NdjsonSink implements LlmSink {
  private lastWrite = Date.now();
  private finished = false;
  private gone = false;
  private readonly listeners: (() => void)[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly res: ResponseLike,
    heartbeatMs: number,
  ) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.on('close', () => {
      if (this.finished) return;
      this.gone = true;
      this.stop();
      for (const l of this.listeners) l();
    });
    // 조용한 시간을 너무 늦게 알아채지 않게 주기의 1/3마다 본다
    this.timer = setInterval(() => {
      if (Date.now() - this.lastWrite >= heartbeatMs) this.write({ type: 'ping' });
    }, Math.max(10, Math.floor(heartbeatMs / 3)));
    this.timer.unref();
  }

  write(event: LlmStreamEvent): void {
    if (this.finished || this.gone) return;
    this.res.write(encodeLlmEvent(event));
    this.lastWrite = Date.now();
  }

  close(): void {
    if (this.finished) return;
    this.finished = true;
    this.stop();
    if (!this.gone) this.res.end();
  }

  onGone(listener: () => void): void {
    if (this.gone) listener();
    else this.listeners.push(listener);
  }

  private stop(): void {
    clearInterval(this.timer);
  }
}
