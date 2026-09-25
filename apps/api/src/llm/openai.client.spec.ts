import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LlmError, type LlmChunk, type LlmTarget } from './llm.provider';
import { OpenAiCompatClient, toLlmError } from './openai.client';

/**
 * B등급 — OpenAI 호환 어댑터를 **가짜 vLLM 서버**(node:http, 이 프로세스 안)로 본다 (P10_설계서_Llm D.2).
 *
 * 밖으로 나가지 않는다. 사내 LLM 실연동은 보류 29다 — 여기 통과는 "우리가 가정한 모양을 우리가 읽는다"까지다.
 */

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string; closed: boolean };
type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void | Promise<void>;

let server: Server;
let base = '';
let handler: Handler;
let seen: Seen[] = [];
const client = new OpenAiCompatClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, closed: false };
      res.on('close', () => (s.closed = true));
      seen.push(s);
      void handler(req, res, s);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
});

const target = (over: Partial<LlmTarget> = {}): LlmTarget => ({ baseUrl: base, model: 'mock-qwen3', apiKey: 'k-test', ...over });
const never = () => new AbortController().signal;

async function collect(it: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
const text = (chunks: LlmChunk[], kind: 'answer' | 'thinking') =>
  chunks
    .filter((c): c is Extract<LlmChunk, { kind: typeof kind }> => c.kind === kind)
    .map((c) => (c as { text: string }).text)
    .join('');

const sse = (res: ServerResponse) => res.writeHead(200, { 'content-type': 'text/event-stream' });
const data = (obj: unknown) => `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

async function thrown(p: Promise<unknown>): Promise<LlmError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LlmError);
    return e as LlmError;
  }
  throw new Error('던지지 않았다');
}

describe('stream — 흘려받기', () => {
  it('조각이 여러 번에 나뉘어 와도 답과 토큰 수를 읽고, 요청은 OpenAI 호환 모양이다', async () => {
    handler = async (_req, res) => {
      sse(res);
      res.write(data(delta({ role: 'assistant', content: '' })));
      await sleep(5);
      // 한 이벤트가 두 조각으로 갈라져 온다
      const half = data(delta({ content: '안' }));
      res.write(half.slice(0, 10));
      await sleep(5);
      res.write(half.slice(10));
      res.write(data(delta({ content: '녕' }, 'stop')));
      res.write(data({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }));
      res.end(data('[DONE]'));
    };
    const chunks = await collect(client.stream(target(), [{ role: 'user', content: '질문' }], never()));
    expect(text(chunks, 'answer')).toBe('안녕');
    expect(chunks.find((c) => c.kind === 'usage')).toEqual({ kind: 'usage', promptTokens: 7, completionTokens: 2 });

    const req = seen[0];
    expect([req.method, req.url]).toEqual(['POST', '/v1/chat/completions']);
    expect(req.headers.authorization).toBe('Bearer k-test');
    expect(JSON.parse(req.body)).toEqual({
      model: 'mock-qwen3',
      messages: [{ role: 'user', content: '질문' }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('키가 없으면 Authorization을 보내지 않는다', async () => {
    handler = (_req, res) => {
      sse(res);
      res.end(data(delta({ content: 'a' })) + data('[DONE]'));
    };
    await collect(client.stream(target({ apiKey: null }), [{ role: 'user', content: 'q' }], never()));
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it('`reasoning_content`는 생각 과정이다 (FR-1119)', async () => {
    handler = (_req, res) => {
      sse(res);
      res.end(data(delta({ reasoning_content: '음…' })) + data(delta({ content: '답' })) + data('[DONE]'));
    };
    const chunks = await collect(client.stream(target(), [], never()));
    expect([text(chunks, 'thinking'), text(chunks, 'answer')]).toEqual(['음…', '답']);
  });

  it('답 앞의 `<think>…</think>`를 떼어 생각 과정으로 — 태그가 조각 경계에서 갈라져도', async () => {
    handler = (_req, res) => {
      sse(res);
      res.end(data(delta({ content: '<thi' })) + data(delta({ content: 'nk>생각</think>\n\n' })) + data(delta({ content: '답' })) + data('[DONE]'));
    };
    const chunks = await collect(client.stream(target(), [], never()));
    expect([text(chunks, 'thinking'), text(chunks, 'answer')]).toEqual(['생각', '답']);
  });

  it('`[DONE]` 없이 끝나도 받은 데까지는 답이다', async () => {
    handler = (_req, res) => {
      sse(res);
      res.end(data(delta({ content: '끝까지' })).trimEnd());
    };
    expect(text(await collect(client.stream(target(), [], never())), 'answer')).toBe('끝까지');
  });

  it('흐름 안의 오류 조각은 거절이다 — 그 메시지로', async () => {
    handler = (_req, res) => {
      sse(res);
      res.end(data(delta({ content: '앞' })) + data({ error: { message: 'boom' } }));
    };
    const e = await thrown(collect(client.stream(target(), [], never())));
    expect([e.kind, e.message]).toEqual(['rejected', 'boom']);
  });

  it('**흘려보내지 않는 200은 받지 않는다** — 완성본 JSON을 "빈 답"으로 끝내지 않게 (검토 반영)', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '완성본' }, finish_reason: 'stop' }] }));
    };
    const e = await thrown(collect(client.stream(target(), [], never())));
    expect([e.kind, /흘려보내지 않았다/.test(e.message)]).toEqual(['protocol', true]);
  });

  it('`finish_reason`을 넘긴다 — `length`면 잘린 답이다 (FR-1120)', async () => {
    handler = (_req, res) => {
      sse(res);
      res.end(data(delta({ content: '길게' })) + data(delta({}, 'length')) + data('[DONE]'));
    };
    expect(await collect(client.stream(target(), [], never()))).toEqual([
      { kind: 'answer', text: '길게' },
      { kind: 'finish', reason: 'length' },
    ]);
  });

  it('**닫는 태그만 오는 모델** — 앞에 흘린 답이 생각 과정이었다고 알린다 (`rethink`, FR-1119)', async () => {
    handler = (_req, res) => {
      sse(res);
      res.end(data(delta({ content: '곰곰이…' })) + data(delta({ content: '</think>\n\n42' })) + data('[DONE]'));
    };
    expect((await collect(client.stream(target(), [], never()))).map((c) => (c.kind === 'answer' ? c.text : c.kind))).toEqual(['곰곰이…', 'rethink', '42']);
  });

  it('**끝나지 않는 한 줄은 상한에서 끊는다** — 메모리에 끝없이 쌓지 않는다 (검토 반영)', async () => {
    handler = (_req, res) => {
      sse(res);
      res.write('data: ');
      res.end('x'.repeat(1_100_000));
    };
    const e = await thrown(collect(client.stream(target(), [], never())));
    expect([e.kind, /너무 길다/.test(e.message)]).toEqual(['protocol', true]);
  });

  it('읽을 수 없는 조각도 실패다 — 모르는 것을 답으로 보여 주지 않는다', async () => {
    handler = (_req, res) => {
      sse(res);
      res.end(data('<html>'));
    };
    const e = await thrown(collect(client.stream(target(), [], never())));
    // 거절이 아니라 응답의 모양이 틀린 것이다 — 감사의 실패 종류가 그렇게 남는다 (종료 루틴 자체 점검 5)
    expect([e.kind, /읽을 수 없다/.test(e.message)]).toEqual(['protocol', true]);
  });
});

describe('stream — 거절·닿지 않음 (FR-1120)', () => {
  it('JSON 오류 본문은 그 메시지로 — HTTP 상태를 함께 든다', async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'error', message: 'The model `x` does not exist.' }));
    };
    const e = await thrown(collect(client.stream(target(), [], never())));
    expect([e.kind, e.message, e.status]).toEqual(['rejected', 'The model `x` does not exist.', 404]);
  });

  it('**대화가 모델의 문맥을 넘으면 "새 대화를 시작한다"를 앞에** — 서버의 문장은 뒤에 (D.3, 검토 반영)', async () => {
    handler = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'error', message: "This model's maximum context length is 32768 tokens." }));
    };
    const e = await thrown(collect(client.stream(target(), [], never())));
    expect(e.message).toBe("대화가 모델이 한 번에 읽을 수 있는 길이를 넘었다 — 새 대화를 시작한다 (LLM 서버: This model's maximum context length is 32768 tokens.)");
  });

  it('**거절 문장이 키를 되읊어도 가린다** — 그 문장은 화면으로 간다', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key: fake-key-aaaa' } }));
    };
    // 시험의 키는 **실제 키 모양을 흉내 내지 않는다**(12.3절 — gitleaks가 잡는다, T-045)
    const e = await thrown(collect(client.stream(target({ apiKey: 'fake-key-aaaa' }), [], never())));
    expect(e.message).toBe('invalid api key: ***');
  });

  it('HTML 오류 쪽은 상태 코드만 — 큰 본문도 끝까지 읽지 않는다', async () => {
    handler = (_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end(`<html>${'x'.repeat(200_000)}</html>`);
    };
    expect((await thrown(collect(client.stream(target(), [], never())))).message).toBe('HTTP 502');
  });

  it('**넘겨주기를 따르지 않는다** — 키가 등록하지 않은 곳으로 가지 않게', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: '/elsewhere/chat/completions' });
      res.end();
    };
    const e = await thrown(collect(client.stream(target(), [], never())));
    expect([e.kind, /넘겼다/.test(e.message)]).toEqual(['unreachable', true]);
    expect(seen.map((s) => s.url)).toEqual(['/v1/chat/completions']);
  });

  it('닿지 않으면 오류 코드만 말한다 — 주소를 싣지 않는다', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const e = await thrown(collect(client.stream(target({ baseUrl: `http://127.0.0.1:${port}/v1` }), [], never())));
    expect(e.kind).toBe('unreachable');
    expect(e.message).toMatch(/닿지 않는다/);
    expect(e.message).not.toContain(String(port));
  });
});

describe('stream — 멈추기 (FR-1113·1115)', () => {
  it('중지하면 aborted로 던지고 **연결을 끊는다**', async () => {
    handler = (_req, res) => {
      sse(res);
      res.write(data(delta({ content: '앞부분' })));
      // 그 뒤로는 아무것도 보내지 않는다 — 생각 중인 모델
    };
    const ac = new AbortController();
    const got: LlmChunk[] = [];
    const run = (async () => {
      for await (const c of client.stream(target(), [], ac.signal)) {
        got.push(c);
        ac.abort();
      }
    })();
    const e = await thrown(run);
    expect(e.kind).toBe('aborted');
    expect(text(got, 'answer')).toBe('앞부분');
    await sleep(20);
    expect(seen[0].closed).toBe(true);
  });

  it('시간 상한이면 timeout으로 던진다', async () => {
    handler = (_req, res) => {
      sse(res);
    };
    const e = await thrown(collect(client.stream(target(), [], AbortSignal.timeout(80))));
    expect(e.kind).toBe('timeout');
  });

  it('**다 읽기 전에 그만 받으면 연결을 끊는다** — 답 상한에서 멈출 때', async () => {
    handler = (_req, res) => {
      sse(res);
      res.write(data(delta({ content: '하나' })));
    };
    for await (const c of client.stream(target(), [], never())) {
      expect(c.kind).toBe('answer');
      break;
    }
    await sleep(20);
    expect(seen[0].closed).toBe(true);
  });
});

describe('toLlmError — `fetch`가 던진 것 (FR-1120)', () => {
  const fetchFailed = (cause: unknown) => Object.assign(new TypeError('fetch failed'), { cause });

  it('**undici의 5분 무응답은 그렇게 말한다** — 우리 전체 상한(`WF_LLM_TIMEOUT_MS`)과 다른 까닭이다 (검토 반영)', () => {
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      const e = toLlmError(fetchFailed({ code }), never());
      expect([e.kind, e.message]).toEqual(['timeout', `LLM 서버가 5분 동안 아무것도 보내지 않았다 (${code})`]);
    }
  });

  it('그 밖의 코드는 닿지 않음 — 코드만', () => {
    expect(toLlmError(fetchFailed({ code: 'ECONNRESET' }), never()).message).toBe('LLM 서버에 닿지 않는다 (ECONNRESET)');
    expect(toLlmError(new Error('x'), never()).message).toBe('LLM 서버에 닿지 않는다');
  });

  it('멈추라는 말이 먼저다 — 시간 상한이면 timeout, 아니면 aborted', () => {
    expect(toLlmError(fetchFailed({ code: 'UND_ERR_BODY_TIMEOUT' }), AbortSignal.abort()).kind).toBe('aborted');
    const timedOut = AbortSignal.abort(new DOMException('t', 'TimeoutError'));
    expect(toLlmError(new Error('x'), timedOut).kind).toBe('timeout');
  });
});

describe('listModels — 연결 확인 (FR-1105)', () => {
  it('`GET /models`의 id를 모은다', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-qwen3' }, { id: 'other' }] }));
    };
    expect(await client.listModels(target(), never())).toEqual(['mock-qwen3', 'other']);
    expect([seen[0].method, seen[0].url, seen[0].headers.authorization]).toEqual(['GET', '/v1/models', 'Bearer k-test']);
  });

  it('거절은 그 메시지로', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    };
    const e = await thrown(client.listModels(target(), never()));
    expect([e.kind, e.message]).toEqual(['rejected', 'invalid api key']);
  });

  it('JSON이 아니거나 모양이 틀리면 `/v1`까지인지 확인하라고 말한다', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>vLLM이 아닌 곳</html>');
    };
    expect((await thrown(client.listModels(target(), never()))).message).toMatch(/\/v1/);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
    };
    expect((await thrown(client.listModels(target(), never()))).kind).toBe('protocol');
  });

  it('너무 큰 목록은 받지 않는다', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`{"data":[${'{"id":"x"},'.repeat(120_000)}{"id":"y"}]}`);
    };
    expect((await thrown(client.listModels(target(), never()))).message).toMatch(/너무 크다/);
  });

  it('넘겨주기·닿지 않음', async () => {
    handler = (_req, res) => {
      res.writeHead(301, { location: 'http://127.0.0.1:1/v1/models' });
      res.end();
    };
    expect((await thrown(client.listModels(target(), never()))).kind).toBe('unreachable');
    const e = await thrown(client.listModels(target(), AbortSignal.abort()));
    expect(e.kind).toBe('aborted');
  });
});
