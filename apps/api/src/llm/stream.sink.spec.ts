import { parseLlmEvent } from '@workfluence/shared';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { NdjsonSink, type ResponseLike } from './stream.sink';

/** B등급 — 흐름의 출구 (P10_설계서_Llm D.1). HTTP 응답은 가짜다 — 실제 흐름은 E2E와 컨테이너 확인이 본다 */

class FakeResponse extends EventEmitter implements ResponseLike {
  destroyed = false;
  statusCode = 0;
  headers: Record<string, string> = {};
  flushed = false;
  chunks: string[] = [];
  ended = 0;
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  flushHeaders(): void {
    this.flushed = true;
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended++;
    this.emit('close');
  }
  lines() {
    return this.chunks.map((c) => parseLlmEvent(c.trimEnd()));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('NdjsonSink', () => {
  it('**머리말을 먼저 보낸다** — 버퍼링을 끄는 머리말과 함께', () => {
    const res = new FakeResponse();
    const sink = new NdjsonSink(res, 60_000);
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    expect(res.flushed).toBe(true);
    sink.close();
  });

  it('줄마다 이벤트 하나, 닫으면 한 번만 끝낸다 — 끝낸 뒤 쓰는 것은 버린다', () => {
    const res = new FakeResponse();
    const sink = new NdjsonSink(res, 60_000);
    sink.write({ type: 'delta', text: 'a\nb' });
    sink.close();
    sink.close();
    sink.write({ type: 'delta', text: '늦음' });
    expect(res.lines()).toEqual([{ type: 'delta', text: 'a\nb' }]);
    expect(res.ended).toBe(1);
  });

  it('**우리가 끝내기 전에 연결이 닫히면** 받는 쪽이 끊긴 것이다 — 알리고 더 쓰지 않는다', () => {
    const res = new FakeResponse();
    const sink = new NdjsonSink(res, 60_000);
    let gone = 0;
    sink.onGone(() => gone++);
    res.emit('close');
    sink.write({ type: 'ping' });
    sink.close();
    expect(gone).toBe(1);
    expect(res.chunks).toEqual([]);
    // 끊긴 응답은 끝내지 않는다
    expect(res.ended).toBe(0);
    // 끊긴 뒤에 듣기 시작해도 바로 알린다
    sink.onGone(() => gone++);
    expect(gone).toBe(2);
  });

  it('**만들 때 이미 끊겨 있으면** 곧바로 끊긴 것으로 — 확인하는 사이 새로 고침한 브라우저 (검토 반영)', () => {
    const res = new FakeResponse();
    res.destroyed = true;
    const sink = new NdjsonSink(res, 60_000);
    let gone = 0;
    sink.onGone(() => gone++);
    sink.write({ type: 'delta', text: 'a' });
    sink.close();
    expect([gone, res.statusCode, res.flushed, res.chunks, res.ended]).toEqual([1, 0, false, [], 0]);
  });

  it('우리가 끝낸 뒤의 닫힘은 끊김이 아니다', () => {
    const res = new FakeResponse();
    const sink = new NdjsonSink(res, 60_000);
    let gone = 0;
    sink.onGone(() => gone++);
    sink.close();
    expect(gone).toBe(0);
  });

  it('**조용하면 살아 있음 줄을 보낸다** (FR-1115) — 쓰는 동안에는 보내지 않는다', async () => {
    const res = new FakeResponse();
    const sink = new NdjsonSink(res, 60);
    await sleep(150);
    const pings = res.lines().filter((l) => l?.type === 'ping').length;
    expect(pings).toBeGreaterThanOrEqual(1);
    sink.close();
    const after = res.chunks.length;
    await sleep(120);
    // 닫은 뒤에는 멈춘다
    expect(res.chunks.length).toBe(after);
  });
});
