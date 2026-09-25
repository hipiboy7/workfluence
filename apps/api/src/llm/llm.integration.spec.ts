import { ConflictException, ForbiddenException, NotFoundException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { LLM_LIMITS, type AppEnv, type LlmStreamEvent, type Principal } from '@workfluence/shared';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { RevocationBus } from '../common/revocation.bus';
import { auditEvents, llmConversations, llmMessages, llmProviders, users } from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { LlmAskService, spell } from './ask.service';
import { LlmConversationsService } from './conversations.service';
import type { ChatMessage } from './domain/openai';
import { LlmError, type LlmChunk, type LlmClient, type LlmTarget } from './llm.provider';
import { LlmPromptsService } from './prompts.service';
import { LlmProvidersService } from './providers.service';
import type { LlmSink } from './stream.sink';

/**
 * B등급 통합 — **실제 PostgreSQL** (3절), LLM은 가짜 (P10_설계서_Llm C·D절).
 *
 * 등록·지시문·보관 규칙·질문 중계를 서비스 층에서 본다. HTTP 배선과 브라우저의 흐름 읽기는 E2E가 본다.
 */

let db: TestDb;
let rootP: Principal;
let aliceP: Principal;
let bobP: Principal;

const MASTER = randomBytes(32).toString('base64url');
const env = (over: Record<string, unknown> = {}) =>
  ({
    WF_UPLOAD_MAX_MB: 20,
    WF_SESSION_IDLE_MINUTES: 30,
    WF_SESSION_ABSOLUTE_HOURS: 12,
    WF_TRASH_RETENTION_DAYS: 30,
    WF_AUDIT_RETENTION_DAYS: 365,
    WF_LLM_MASTER_KEY: MASTER,
    WF_LLM_TIMEOUT_MS: 5_000,
    ...over,
  }) as unknown as AppEnv;

/** 가짜 LLM — 질문마다 대본을 바꿔 끼운다. 받은 것을 적어 둔다 */
class FakeLlm implements LlmClient {
  script: (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<LlmChunk> = async function* () {
    yield { kind: 'answer', text: '답' };
  };
  models: string[] | LlmError = ['mock-qwen3'];
  calls: { target: LlmTarget; messages: ChatMessage[] }[] = [];
  stream(target: LlmTarget, messages: ChatMessage[], signal: AbortSignal): AsyncIterable<LlmChunk> {
    this.calls.push({ target, messages });
    return this.script(messages, signal);
  }
  listModels(): Promise<string[]> {
    return this.models instanceof LlmError ? Promise.reject(this.models) : Promise.resolve(this.models);
  }
}

/** 배열에 담는 출구. `disconnect()`는 브라우저가 창을 닫은 것이다 */
class ArraySink implements LlmSink {
  events: LlmStreamEvent[] = [];
  closed = false;
  private readonly listeners: (() => void)[] = [];
  write(e: LlmStreamEvent): void {
    this.events.push(e);
  }
  close(): void {
    this.closed = true;
  }
  onGone(l: () => void): void {
    this.listeners.push(l);
  }
  disconnect(): void {
    for (const l of this.listeners) l();
  }
  get end(): Extract<LlmStreamEvent, { type: 'end' }> {
    const e = this.events.find((x) => x.type === 'end');
    if (!e || e.type !== 'end') throw new Error('end가 없다');
    return e;
  }
  text(type: 'delta' | 'thinking'): string {
    return this.events.map((e) => (e.type === type ? e.text : '')).join('');
  }
}

/** 멈추라는 말이 올 때까지 기다린다 — 생각 중인 모델 */
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

let fake: FakeLlm;
let settings: SettingsService;
let audit: AuditService;
let providers: LlmProvidersService;
let prompts: LlmPromptsService;
let conversations: LlmConversationsService;
let ask: LlmAskService;
let bus: RevocationBus;

function build(over: Record<string, unknown> = {}) {
  bus = new RevocationBus();
  fake = new FakeLlm();
  settings = new SettingsService(db, env(over));
  audit = new AuditService(db);
  providers = new LlmProvidersService(db, env(over), fake);
  prompts = new LlmPromptsService(db);
  conversations = new LlmConversationsService(db, settings, audit);
  ask = new LlmAskService(db, env(over), audit, providers, prompts, conversations, fake, bus);
}

async function mkUser(username: string, role: string): Promise<Principal> {
  const [u] = await db
    .insert(users)
    .values({ username, displayName: `${username} 이름`, passwordHash: 'x', role, status: 'active' })
    .returning();
  return { id: u.id, role: u.role as Principal['role'] };
}

async function registerProvider(over: { name?: string; apiKey?: string | null; model?: string } = {}) {
  return providers.create(
    { name: over.name ?? '사내 Qwen', baseUrl: 'http://llm.example.internal:8000/v1', model: over.model ?? 'mock-qwen3', apiKey: over.apiKey === undefined ? 'k-secret-123' : over.apiKey },
    rootP,
  );
}

/** 질문 하나를 끝까지 — prepare → run */
async function askOnce(me: Principal, dto: { providerId: string; question: string; conversationId?: string; promptId?: string }, sink = new ArraySink()) {
  const p = await ask.prepare(me, dto);
  await ask.run(me, p, sink, '127.0.0.9');
  return sink;
}

async function setPolicy(patch: Record<string, unknown>) {
  await db.transaction((tx) => settings.update(patch, rootP, tx));
  settings.invalidate();
}

beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  rootP = await mkUser('llm-root', 'root');
  aliceP = await mkUser('llm-alice', 'member');
  bobP = await mkUser('llm-bob', 'member');
  build();
});

describe('LLM 등록 (FR-1100~1108)', () => {
  it('**키는 암호문으로만 들어가고 어디로도 다시 나가지 않는다** (FR-1102)', async () => {
    const view = await registerProvider();
    expect(view).toMatchObject({ name: '사내 Qwen', model: 'mock-qwen3', baseUrl: 'http://llm.example.internal:8000/v1', hasKey: true, createdByName: 'llm-root 이름' });
    expect(JSON.stringify(view)).not.toContain('k-secret-123');
    const row = await db.query.llmProviders.findFirst({ where: eq(llmProviders.id, view.id) });
    expect(row?.apiKeyEnc?.startsWith('v1.')).toBe(true);
    expect(row?.apiKeyEnc).not.toContain('k-secret-123');
    // 일반 목록은 이름과 모델만 (FR-1107)
    expect(await providers.list()).toEqual([{ id: view.id, name: '사내 Qwen', model: 'mock-qwen3' }]);
    expect(JSON.stringify(await providers.listAdmin(rootP))).not.toContain('k-secret');
    // 푸는 것은 부를 때뿐이다
    expect((await providers.resolve(view.id)).target).toEqual({ baseUrl: 'http://llm.example.internal:8000/v1', model: 'mock-qwen3', apiKey: 'k-secret-123' });
  });

  it('root만 등록·관리 목록·삭제·연결 확인을 한다 — admin도 아니다 (A.1-1)', async () => {
    const adminP = await mkUser('llm-admin', 'admin');
    const view = await registerProvider();
    for (const who of [adminP, aliceP]) {
      await expect(providers.create({ name: 'x', baseUrl: 'http://a.example.internal/v1', model: 'm', apiKey: null }, who)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(providers.listAdmin(who)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(providers.remove(view.id, who)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(providers.check(view.id, who)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('**마스터 키가 없으면 키가 있는 등록을 거부한다** — 키 없는 등록은 된다 (FR-1103)', async () => {
    build({ WF_LLM_MASTER_KEY: '' });
    await expect(registerProvider()).rejects.toBeInstanceOf(BadRequestException);
    const view = await registerProvider({ apiKey: null });
    expect(view.hasKey).toBe(false);
    expect((await providers.resolve(view.id)).target.apiKey).toBeNull();
  });

  it('같은 이름이면 409 (FR-1108)', async () => {
    await registerProvider();
    await expect(registerProvider()).rejects.toBeInstanceOf(ConflictException);
  });

  it('**마스터 키가 바뀌면 풀 수 없다고 말한다** — 질문은 503, 연결 확인은 까닭 (D.4)', async () => {
    const view = await registerProvider();
    build({ WF_LLM_MASTER_KEY: randomBytes(32).toString('base64url') });
    await expect(providers.resolve(view.id)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const check = await providers.check(view.id, rootP);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toMatch(/풀 수 없다/);
    // 마스터 키를 지운 경우도 같다
    build({ WF_LLM_MASTER_KEY: '' });
    await expect(providers.resolve(view.id)).rejects.toThrow(/WF_LLM_MASTER_KEY/);
  });

  it('**다른 행으로 옮겨 붙인 암호문은 풀리지 않는다** — AAD가 행 id에 묶여 있다', async () => {
    const a = await registerProvider({ name: 'A' });
    const b = await registerProvider({ name: 'B', apiKey: 'k-other' });
    const rowA = await db.query.llmProviders.findFirst({ where: eq(llmProviders.id, a.id) });
    await db.update(llmProviders).set({ apiKeyEnc: rowA?.apiKeyEnc }).where(eq(llmProviders.id, b.id));
    await expect(providers.resolve(b.id)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('연결 확인 — 모델 목록과 등록한 모델이 있는지 (FR-1105)', async () => {
    const view = await registerProvider();
    expect(await providers.check(view.id, rootP)).toEqual({ ok: true, models: ['mock-qwen3'], modelFound: true });
    fake.models = ['other'];
    expect(await providers.check(view.id, rootP)).toEqual({ ok: true, models: ['other'], modelFound: false });
    fake.models = new LlmError('unreachable', 'LLM 서버에 닿지 않는다 (ECONNREFUSED)');
    expect(await providers.check(view.id, rootP)).toEqual({ ok: false, message: 'LLM 서버에 닿지 않는다 (ECONNREFUSED)' });
    fake.models = new LlmError('timeout', '시간 상한');
    expect(await providers.check(view.id, rootP)).toMatchObject({ ok: false, message: expect.stringMatching(/초 안에/) as string });
    await expect(providers.check('00000000-0000-4000-8000-000000000000', rootP)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('삭제하면 404로 사라지고, 없는 것은 404', async () => {
    const view = await registerProvider();
    expect(await providers.remove(view.id, rootP)).toEqual({ name: '사내 Qwen', model: 'mock-qwen3', baseUrl: 'http://llm.example.internal:8000/v1', hasKey: true });
    await expect(providers.resolve(view.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(providers.remove(view.id, rootP)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('지시문 (FR-1125~1129)', () => {
  it('만들고·고치고·지운다 — 이름 순', async () => {
    const b = await prompts.create(aliceP, { name: '나중', content: '둘' });
    const a = await prompts.create(aliceP, { name: '가장 먼저', content: '하나' });
    expect((await prompts.list(aliceP)).map((p) => p.name)).toEqual(['가장 먼저', '나중']);
    const up = await prompts.update(aliceP, b.id, { content: '고친 둘' });
    expect([up.name, up.content]).toEqual(['나중', '고친 둘']);
    await prompts.remove(aliceP, a.id);
    expect((await prompts.list(aliceP)).map((p) => p.id)).toEqual([b.id]);
  });

  it('**남의 지시문은 없는 것과 같다** (FR-1128)', async () => {
    const p = await prompts.create(aliceP, { name: '비밀', content: '앨리스의 것' });
    expect(await prompts.list(bobP)).toEqual([]);
    await expect(prompts.getOwned(bobP, p.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(prompts.update(bobP, p.id, { content: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(prompts.remove(bobP, p.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('이름이 겹치면 409 — 만들 때도 바꿀 때도. 남의 이름과는 겹쳐도 된다', async () => {
    await prompts.create(aliceP, { name: '요약', content: 'a' });
    const other = await prompts.create(aliceP, { name: '번역', content: 'b' });
    await expect(prompts.create(aliceP, { name: '요약', content: 'c' })).rejects.toBeInstanceOf(ConflictException);
    await expect(prompts.update(aliceP, other.id, { name: '요약' })).rejects.toBeInstanceOf(ConflictException);
    expect((await prompts.update(aliceP, other.id, { name: '번역' })).name).toBe('번역');
    await prompts.create(bobP, { name: '요약', content: 'bob' });
  });

  it(`사람마다 ${LLM_LIMITS.promptsPerUser}개까지`, async () => {
    for (let i = 0; i < LLM_LIMITS.promptsPerUser; i++) await prompts.create(aliceP, { name: `p${i}`, content: 'x' });
    await expect(prompts.create(aliceP, { name: 'over', content: 'x' })).rejects.toBeInstanceOf(ConflictException);
    await prompts.create(bobP, { name: 'bob', content: 'x' });
  });
});

describe('질문 — 흘려보내고 저장한다 (FR-1110~1120)', () => {
  it('새 대화: 지시문이 system으로 먼저 가고, 답을 흘려보내고, 대화·질문·답을 남긴다', async () => {
    const provider = await registerProvider();
    const prompt = await prompts.create(aliceP, { name: '세 줄', content: '세 줄로 답한다' });
    fake.script = async function* () {
      yield { kind: 'thinking', text: '음…' };
      yield { kind: 'answer', text: '첫 ' };
      yield { kind: 'answer', text: '답' };
      yield { kind: 'usage', promptTokens: 11, completionTokens: 3 };
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, promptId: prompt.id, question: '회의록 요약\n본문…' });

    expect(fake.calls[0].messages).toEqual([
      { role: 'system', content: '세 줄로 답한다' },
      { role: 'user', content: '회의록 요약\n본문…' },
    ]);
    expect(fake.calls[0].target.apiKey).toBe('k-secret-123');
    expect([sink.text('delta'), sink.text('thinking')]).toEqual(['첫 답', '음…']);
    expect(sink.end).toMatchObject({ status: 'done', saved: true, evicted: 0, message: null });
    expect(sink.closed).toBe(true);

    const view = await conversations.get(aliceP, sink.end.conversationId as string);
    expect(view).toMatchObject({ title: '회의록 요약', promptName: '세 줄', systemPrompt: '세 줄로 답한다', providerName: '사내 Qwen', pinned: false });
    expect(view.messages.map((m) => [m.role, m.content, m.status, m.model])).toEqual([
      ['user', '회의록 요약\n본문…', 'done', null],
      // **생각 과정은 저장하지 않는다** (FR-1119)
      ['assistant', '첫 답', 'done', 'mock-qwen3'],
    ]);
  });

  it('**감사로그에는 크기와 결과만 — 내용은 없다** (FR-1118)', async () => {
    const provider = await registerProvider();
    const sink = await askOnce(aliceP, { providerId: provider.id, question: '비밀 업무 내용' });
    const [ev] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'llm.ask'));
    expect(ev).toMatchObject({ actorId: aliceP.id, targetType: 'llm.conversation', targetId: sink.end.conversationId, ip: '127.0.0.9' });
    expect(ev.detail).toMatchObject({ provider: '사내 Qwen', model: 'mock-qwen3', status: 'done', saved: true, newConversation: true, questionChars: 8, answerChars: 1 });
    expect(JSON.stringify(ev.detail)).not.toContain('비밀');
    expect(JSON.stringify(ev.detail)).not.toContain('k-secret');
  });

  it('이어 묻기: 앞 이력을 보내고, 시작할 때의 지시문을 쓴다 — **그 사이 지시문을 고쳐도** (FR-1127)', async () => {
    const provider = await registerProvider();
    const prompt = await prompts.create(aliceP, { name: '짧게', content: '짧게 답한다' });
    const first = await askOnce(aliceP, { providerId: provider.id, promptId: prompt.id, question: '첫 질문' });
    await prompts.update(aliceP, prompt.id, { content: '길게 답한다' });
    fake.script = async function* () {
      yield { kind: 'answer', text: '둘째 답' };
    };
    const id = first.end.conversationId as string;
    const second = await askOnce(aliceP, { providerId: provider.id, conversationId: id, question: '둘째 질문' });
    expect(second.end).toMatchObject({ status: 'done', saved: true, conversationId: id });
    expect(fake.calls[1].messages).toEqual([
      { role: 'system', content: '짧게 답한다' },
      { role: 'user', content: '첫 질문' },
      { role: 'assistant', content: '답' },
      { role: 'user', content: '둘째 질문' },
    ]);
    expect((await conversations.get(aliceP, id)).messages.map((m) => m.content)).toEqual(['첫 질문', '답', '둘째 질문', '둘째 답']);
  });

  it('**남의 대화·지시문으로는 묻지 못한다** — 404 (FR-1128·1139)', async () => {
    const provider = await registerProvider();
    const mine = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    const prompt = await prompts.create(aliceP, { name: 'p', content: 'c' });
    await expect(ask.prepare(bobP, { providerId: provider.id, conversationId: mine.end.conversationId as string, question: 'q' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(ask.prepare(bobP, { providerId: provider.id, promptId: prompt.id, question: 'q' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(ask.prepare(aliceP, { providerId: '00000000-0000-4000-8000-000000000000', question: 'q' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('**한 사람이 동시에 하나만** — 두 번째는 409, 끝나면 다시 된다 (FR-1114)', async () => {
    const provider = await registerProvider();
    const first = await ask.prepare(aliceP, { providerId: provider.id, question: 'a' });
    await expect(ask.prepare(aliceP, { providerId: provider.id, question: 'b' })).rejects.toBeInstanceOf(ConflictException);
    // 다른 사람은 막지 않는다
    const bob = await ask.prepare(bobP, { providerId: provider.id, question: 'c' });
    await ask.run(aliceP, first, new ArraySink(), null);
    await ask.run(bobP, bob, new ArraySink(), null);
    await askOnce(aliceP, { providerId: provider.id, question: 'd' });
    // `run`을 부르지 못한 자리는 `release`가 푼다
    const dangling = await ask.prepare(aliceP, { providerId: provider.id, question: 'e' });
    ask.release(aliceP, dangling);
    await askOnce(aliceP, { providerId: provider.id, question: 'f' });
  });

  it('**중지하면 거기까지를 "중지됨"으로 남긴다** (FR-1113)', async () => {
    const provider = await registerProvider();
    fake.script = async function* (_m, signal) {
      yield { kind: 'answer', text: '앞부분' };
      await untilAborted(signal);
      throw new LlmError('aborted', '중지했다');
    };
    expect(ask.stop(aliceP)).toBe(false);
    const p = await ask.prepare(aliceP, { providerId: provider.id, question: 'q' });
    const sink = new ArraySink();
    const running = ask.run(aliceP, p, sink, null);
    await new Promise((r) => setTimeout(r, 20));
    expect(ask.stop(aliceP)).toBe(true);
    await running;
    expect(sink.end).toMatchObject({ status: 'stopped', saved: true });
    const view = await conversations.get(aliceP, sink.end.conversationId as string);
    expect(view.messages[1]).toMatchObject({ content: '앞부분', status: 'stopped' });
  });

  it('멈추라는 말에 어댑터가 던지지 않고 닫아도 "중지됨"이다', async () => {
    const provider = await registerProvider();
    fake.script = async function* (_m, signal) {
      yield { kind: 'answer', text: '조금' };
      await untilAborted(signal);
    };
    const p = await ask.prepare(aliceP, { providerId: provider.id, question: 'q' });
    const sink = new ArraySink();
    const running = ask.run(aliceP, p, sink, null);
    await new Promise((r) => setTimeout(r, 20));
    ask.stop(aliceP);
    await running;
    expect(sink.end.status).toBe('stopped');
  });

  it('**창을 닫아도** LLM 요청을 끊고 거기까지를 저장한다', async () => {
    const provider = await registerProvider();
    let aborted = false;
    fake.script = async function* (_m, signal) {
      yield { kind: 'answer', text: '읽던 답' };
      await untilAborted(signal);
      aborted = true;
      throw new LlmError('aborted', '중지했다');
    };
    const p = await ask.prepare(aliceP, { providerId: provider.id, question: 'q' });
    const sink = new ArraySink();
    const running = ask.run(aliceP, p, sink, null);
    await new Promise((r) => setTimeout(r, 20));
    sink.disconnect();
    await running;
    expect(aborted).toBe(true);
    expect(sink.end).toMatchObject({ status: 'stopped', saved: true });
  });

  it('**글자가 하나도 없으면 저장하지 않는다** — 까닭을 말하고, 물었다는 사실은 감사로그에 (D.5)', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield* [];
      throw new LlmError('unreachable', 'LLM 서버에 닿지 않는다 (ECONNREFUSED)');
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.end).toEqual({ type: 'end', status: 'failed', saved: false, conversationId: null, evicted: 0, message: 'LLM 서버에 닿지 않는다 (ECONNREFUSED)' });
    expect((await conversations.list(aliceP)).items).toEqual([]);
    const [ev] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'llm.ask'));
    expect(ev.detail).toMatchObject({ status: 'failed', saved: false, answerChars: 0 });
  });

  it('도중에 끊기면 받은 데까지를 "끊김"으로 남기고 까닭을 말한다', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield { kind: 'answer', text: '반쯤' };
      throw new LlmError('rejected', 'boom');
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.end).toMatchObject({ status: 'failed', saved: true, message: 'boom' });
    const view = await conversations.get(aliceP, sink.end.conversationId as string);
    expect(view.messages[1]).toMatchObject({ content: '반쯤', status: 'failed' });
  });

  it('시간 상한을 넘으면 몇 분인지 말한다 (FR-1115)', async () => {
    build({ WF_LLM_TIMEOUT_MS: 60 });
    const provider = await registerProvider();
    fake.script = async function* (_m, signal) {
      await untilAborted(signal);
      yield* [];
      throw new LlmError('timeout', '시간 상한을 넘었다');
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.end).toMatchObject({ status: 'failed', saved: false });
    expect(sink.end.message).toBe('시간 상한(0초)을 넘었다');
  });

  it('시간 상한을 사람 말로 — 1분 이상은 분, 그 아래는 초', () => {
    expect([spell(600_000), spell(90_000), spell(59_000), spell(0)]).toEqual(['10분', '2분', '59초', '0초']);
  });

  it('어댑터가 모르는 것을 던지면 "처리하지 못했다" — 내용은 로그에 싣지 않는다', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield { kind: 'answer', text: '앞' };
      throw new TypeError('뜻밖');
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.end).toMatchObject({ status: 'failed', saved: true, message: 'LLM 응답을 처리하지 못했다' });
  });

  it('**답이 상한을 넘으면 상한까지만 받고 끊는다** (FR-1116)', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield { kind: 'answer', text: 'a'.repeat(LLM_LIMITS.answerMaxChars - 5) };
      yield { kind: 'answer', text: 'b'.repeat(10) };
      yield { kind: 'answer', text: '안 온다' };
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.end).toMatchObject({ status: 'failed', saved: true });
    expect(sink.end.message).toMatch(/상한/);
    expect(sink.text('delta').length).toBe(LLM_LIMITS.answerMaxChars);
    const view = await conversations.get(aliceP, sink.end.conversationId as string);
    expect(view.messages[1].content.length).toBe(LLM_LIMITS.answerMaxChars);
  });

  it('답이 상한에 딱 닿은 뒤 더 오면 더 보내지 않는다', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield { kind: 'answer', text: 'a'.repeat(LLM_LIMITS.answerMaxChars) };
      yield { kind: 'answer', text: 'b' };
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.events.filter((e) => e.type === 'delta')).toHaveLength(1);
    expect(sink.end.status).toBe('failed');
  });

  it('생각 과정이 상한을 넘어도 끊는다 — 답이 없으면 저장하지 않는다', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield { kind: 'thinking', text: 't'.repeat(LLM_LIMITS.answerMaxChars + 1) };
      yield { kind: 'answer', text: '안 온다' };
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.end).toMatchObject({ status: 'failed', saved: false });
    expect(sink.end.message).toMatch(/생각 과정/);
  });

  it(`대화 하나에 ${LLM_LIMITS.messagesPerConversation}개를 넘기지 않는다 — 몰래 자르지 않고 새 대화로 (D.3)`, async () => {
    const provider = await registerProvider();
    const first = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    const id = first.end.conversationId as string;
    const filler = Array.from({ length: LLM_LIMITS.messagesPerConversation - 2 }, (_, i) => ({
      conversationId: id,
      role: i % 2 ? 'assistant' : 'user',
      content: `m${i}`,
      status: 'done',
    }));
    await db.insert(llmMessages).values(filler);
    await expect(ask.prepare(aliceP, { providerId: provider.id, conversationId: id, question: 'more' })).rejects.toThrow(/새 대화/);
  });

  it('LLM을 지우면 대화는 남는다 — LLM 이름만 빈다 (FR-1101)', async () => {
    const provider = await registerProvider();
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    await providers.remove(provider.id, rootP);
    const view = await conversations.get(aliceP, sink.end.conversationId as string);
    expect([view.providerId, view.providerName, view.messages.length]).toEqual([null, null, 2]);
    // 다른 LLM으로 이어 묻는다
    const other = await registerProvider({ name: '다른 LLM' });
    const again = await askOnce(aliceP, { providerId: other.id, conversationId: view.id, question: 'q2' });
    expect(again.end.saved).toBe(true);
    expect((await conversations.get(aliceP, view.id)).providerName).toBe('다른 LLM');
  });

  it('**답을 받는 사이에 대화가 지워지면** 저장하지 않고 그렇게 말한다', async () => {
    const provider = await registerProvider();
    const first = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    const id = first.end.conversationId as string;
    fake.script = async function* () {
      await db.delete(llmConversations).where(eq(llmConversations.id, id));
      yield { kind: 'answer', text: '늦은 답' };
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, conversationId: id, question: 'q2' });
    expect(sink.end).toMatchObject({ status: 'done', saved: false, conversationId: id });
    expect(sink.end.message).toMatch(/지워져/);
  });

  it('**답을 받는 사이 LLM이 지워져도 대화는 남는다** — LLM 칸만 빈다 (FR-1101, 검토 반영)', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      await providers.remove(provider.id, rootP);
      yield { kind: 'answer', text: '끝까지 받은 답' };
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.end).toMatchObject({ status: 'done', saved: true });
    const view = await conversations.get(aliceP, sink.end.conversationId as string);
    expect([view.providerId, view.messages.map((m) => m.content)]).toEqual([null, ['q', '끝까지 받은 답']]);
  });

  it('저장이 실패하면 "저장하지 못했다" — 흐름은 끝을 말하고 자리를 푼다', async () => {
    const provider = await registerProvider();
    // DTO를 거치지 않은 U+0000 — PostgreSQL text가 거부한다(22021). 로그에는 코드와 문장만 간다(`errorText`)
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'a\u0000b' });
    expect(sink.end).toMatchObject({ saved: false, message: '답을 저장하지 못했다' });
    expect((await askOnce(aliceP, { providerId: provider.id, question: 'q' })).end.saved).toBe(true);
  });

  it('**모델이 U+0000을 내도 저장이 실패하지 않는다** — 빼고 남긴다', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield { kind: 'answer', text: '앞\u0000뒤' };
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.end.saved).toBe(true);
    expect((await conversations.get(aliceP, sink.end.conversationId as string)).messages[1].content).toBe('앞뒤');
  });

  it('**답을 받는 사이 만료된 대화도 살린다** — 물을 때 보였던 대화다', async () => {
    const provider = await registerProvider();
    const first = await askOnce(aliceP, { providerId: provider.id, question: 'q1' });
    const id = first.end.conversationId as string;
    const p = await ask.prepare(aliceP, { providerId: provider.id, conversationId: id, question: 'q2' });
    await db.update(llmConversations).set({ retainFrom: new Date(Date.now() - 8 * 86_400_000) }).where(eq(llmConversations.id, id));
    const sink = new ArraySink();
    await ask.run(aliceP, p, sink, null);
    expect(sink.end).toMatchObject({ saved: true, conversationId: id });
    expect((await conversations.list(aliceP)).items.map((i) => i.id)).toEqual([id]);
  });

  it('**토큰 수가 감사로그에 남는다** — 이름에 `token`이 들어가면 비밀 거르기가 버리던 것 (FR-1118, 검토 반영)', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield { kind: 'answer', text: '답' };
      yield { kind: 'usage', promptTokens: 11, completionTokens: 3 };
    };
    await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    const [ev] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'llm.ask'));
    expect(ev.detail).toMatchObject({ usage: { prompt: 11, completion: 3 }, failure: null, httpStatus: null });
  });

  it('**LLM이 거절하면 까닭은 화면에, 종류와 HTTP 상태는 감사로그에**', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield* [];
      throw new LlmError('rejected', '대화가 모델이 한 번에 읽을 수 있는 길이를 넘었다 — 새 대화를 시작한다 (LLM 서버: …)', 400);
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.end.message).toMatch(/새 대화를 시작한다/);
    const [ev] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'llm.ask'));
    expect(ev.detail).toMatchObject({ status: 'failed', failure: 'rejected', httpStatus: 400 });
    expect(JSON.stringify(ev.detail)).not.toContain('읽을 수 있는 길이');
  });

  it('**모델의 길이 상한에서 잘린 답은 끝난 것으로 치지 않는다** (`finish_reason: length`, FR-1120)', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield { kind: 'answer', text: '길게 쓰다가' };
      yield { kind: 'finish', reason: 'length' };
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.end).toMatchObject({ status: 'failed', saved: true });
    expect(sink.end.message).toMatch(/길이 상한에서 잘렸다/);
    expect((await conversations.get(aliceP, sink.end.conversationId as string)).messages[1].status).toBe('failed');
    fake.script = async function* () {
      yield { kind: 'answer', text: '다 썼다' };
      yield { kind: 'finish', reason: 'stop' };
    };
    expect((await askOnce(aliceP, { providerId: provider.id, question: 'q2' })).end.status).toBe('done');
  });

  it('**`rethink` — 앞에 흘린 답은 생각 과정이었다**: 화면에 알리고, 저장·이력에서 뺀다 (FR-1119)', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield { kind: 'answer', text: '곰곰이 생각하면…' };
      yield { kind: 'rethink' };
      yield { kind: 'answer', text: '42' };
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(sink.events.map((e) => e.type)).toEqual(['delta', 'rethink', 'delta', 'end']);
    expect((await conversations.get(aliceP, sink.end.conversationId as string)).messages[1].content).toBe('42');
  });

  it('어댑터가 말한 시간 제한(조각 사이 무응답)은 그 문장대로 — 우리 전체 상한과 섞지 않는다', async () => {
    const provider = await registerProvider();
    fake.script = async function* () {
      yield* [];
      throw new LlmError('timeout', 'LLM 서버가 5분 동안 아무것도 보내지 않았다 (UND_ERR_BODY_TIMEOUT)');
    };
    expect((await askOnce(aliceP, { providerId: provider.id, question: 'q' })).end.message).toBe('LLM 서버가 5분 동안 아무것도 보내지 않았다 (UND_ERR_BODY_TIMEOUT)');
  });
});

describe('세션을 끊으면 흐름도 끊긴다 (FR-1121, 검토 반영)', () => {
  const streamUntilAbort = () =>
    async function* (_m: ChatMessage[], signal: AbortSignal): AsyncIterable<LlmChunk> {
      yield { kind: 'answer', text: '앞부분' };
      await untilAborted(signal);
      throw new LlmError('aborted', '중지했다');
    };

  it('**그 사람의 모든 세션을 끊으면**(비밀번호 변경·강제 종료) 답을 멈추고 그렇게 말한다', async () => {
    const provider = await registerProvider();
    fake.script = streamUntilAbort();
    const p = await ask.prepare(aliceP, { providerId: provider.id, question: 'q' }, 'sid-a');
    const sink = new ArraySink();
    const running = ask.run(aliceP, p, sink, null);
    await new Promise((r) => setTimeout(r, 20));
    bus.revoke(bobP.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(sink.events.some((e) => e.type === 'end')).toBe(false);
    bus.revoke(aliceP.id);
    await running;
    expect(sink.end).toMatchObject({ status: 'stopped', saved: true, message: '세션이 끝나 답을 멈췄다 — 다시 로그인한다' });
    const [ev] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'llm.ask'));
    expect(ev.detail).toMatchObject({ failure: 'revoked' });
  });

  it('**로그아웃은 그 세션의 답만** — 다른 세션이 연 답은 그대로', async () => {
    const provider = await registerProvider();
    fake.script = streamUntilAbort();
    const p = await ask.prepare(aliceP, { providerId: provider.id, question: 'q' }, 'sid-a');
    const sink = new ArraySink();
    const running = ask.run(aliceP, p, sink, null);
    await new Promise((r) => setTimeout(r, 20));
    bus.revoke(aliceP.id, 'sid-other');
    await new Promise((r) => setTimeout(r, 20));
    expect(sink.events.some((e) => e.type === 'end')).toBe(false);
    bus.revoke(aliceP.id, 'sid-a');
    await running;
    expect(sink.end.status).toBe('stopped');
  });

  it('모듈이 내려가면 구독을 푼다 — 그 뒤의 파기 통지는 이 서비스에 닿지 않는다', async () => {
    const provider = await registerProvider();
    fake.script = streamUntilAbort();
    const p = await ask.prepare(aliceP, { providerId: provider.id, question: 'q' });
    const sink = new ArraySink();
    const running = ask.run(aliceP, p, sink, null);
    ask.onModuleDestroy();
    bus.revoke(aliceP.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(sink.events.some((e) => e.type === 'end')).toBe(false);
    ask.stop(aliceP);
    await running;
    expect(sink.end).toMatchObject({ status: 'stopped', message: null });
  });
});

describe('질문 — 끝 (보관 규칙은 아래)', () => {
  it('자리는 끝나면 풀린다', async () => {
    const provider = await registerProvider();
    await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(ask.stop(aliceP)).toBe(false);
  });

  it('**답이 끝나 저장하는 사이의 중지는 멈춘 것이 없다고 답한다** — 끝난 답은 끝난 것으로 남는다 (검토 반영)', async () => {
    const provider = await registerProvider();
    const save = conversations.saveExchange.bind(conversations);
    let during: boolean | null = null;
    conversations.saveExchange = (x, tx) => {
      during = ask.stop(aliceP);
      return save(x, tx);
    };
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'q' });
    expect(during).toBe(false);
    expect(sink.end).toMatchObject({ status: 'done', saved: true });
  });
});

describe('보관 규칙 (FR-1130~1139)', () => {
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

  async function conversation(me: Principal, providerId: string, question: string): Promise<string> {
    return (await askOnce(me, { providerId, question })).end.conversationId as string;
  }

  it('**상한을 넘으면 고정하지 않은 것 중 가장 오래된 것부터 지운다** — 고정은 남는다, 지운 수를 말한다 (FR-1132)', async () => {
    await setPolicy({ llmConversationMax: 3, llmPinnedMax: 1 });
    const provider = await registerProvider();
    const a = await conversation(aliceP, provider.id, 'a');
    const b = await conversation(aliceP, provider.id, 'b');
    const c = await conversation(aliceP, provider.id, 'c');
    await conversations.pin(aliceP, a);
    // 시각이 같지 않게 기준을 벌린다
    await db.update(llmConversations).set({ retainFrom: ago(3) }).where(eq(llmConversations.id, b));
    await db.update(llmConversations).set({ retainFrom: ago(2) }).where(eq(llmConversations.id, c));
    const sink = await askOnce(aliceP, { providerId: provider.id, question: 'd' });
    expect(sink.end.evicted).toBe(1);
    const ids = (await conversations.list(aliceP)).items.map((i) => i.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
    expect(ids).toContain(c);
    expect(ids).toHaveLength(3);
    // 남의 대화는 세지 않는다
    await conversation(bobP, provider.id, 'bob');
    expect((await conversations.list(aliceP)).items).toHaveLength(3);
  });

  it('**만료된 것은 없는 것과 같다** — 목록·열기·이어 묻기·지우기 모두 (FR-1137)', async () => {
    const provider = await registerProvider();
    const id = await conversation(aliceP, provider.id, 'old');
    await db.update(llmConversations).set({ retainFrom: ago(8) }).where(eq(llmConversations.id, id));
    const list = await conversations.list(aliceP);
    expect(list.items).toEqual([]);
    expect(list.limits).toEqual({ retentionDays: 7, conversationMax: 100, pinnedMax: 20 });
    await expect(conversations.get(aliceP, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ask.prepare(aliceP, { providerId: provider.id, conversationId: id, question: 'q' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(conversations.pin(aliceP, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(conversations.remove(aliceP, id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('정리는 만료된 것만 지우고 수를 감사로그에 — 고정한 것은 오래돼도 남는다 (FR-1136)', async () => {
    const provider = await registerProvider();
    const old = await conversation(aliceP, provider.id, 'old');
    const pinned = await conversation(aliceP, provider.id, 'pinned');
    const fresh = await conversation(bobP, provider.id, 'fresh');
    await conversations.pin(aliceP, pinned);
    await db.update(llmConversations).set({ retainFrom: ago(30) }).where(sql`${llmConversations.id} IN (${old}, ${pinned})`);
    expect(await conversations.sweepExpired()).toBe(1);
    const left = (await db.select({ id: llmConversations.id }).from(llmConversations)).map((r) => r.id).sort();
    expect(left).toEqual([pinned, fresh].sort());
    // 메시지도 함께 지워진다
    expect(await db.select().from(llmMessages).where(eq(llmMessages.conversationId, old))).toEqual([]);
    const [ev] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'llm.conversation.purge'));
    expect(ev.detail).toEqual({ deleted: 1, retentionDays: 7 });
    // 지울 것이 없으면 남기지 않는다 — 한 시간마다 "0건"이 쌓이지 않게
    expect(await conversations.sweepExpired()).toBe(0);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.action, 'llm.conversation.purge'))).toHaveLength(1);
  });

  it('**고정은 K개까지**, 이미 고정한 것은 그대로, 상한을 낮춰도 있던 고정은 풀지 않는다 (FR-1133)', async () => {
    await setPolicy({ llmPinnedMax: 2 });
    const provider = await registerProvider();
    const [a, b, c] = [await conversation(aliceP, provider.id, 'a'), await conversation(aliceP, provider.id, 'b'), await conversation(aliceP, provider.id, 'c')];
    await conversations.pin(aliceP, a);
    await conversations.pin(aliceP, a);
    await conversations.pin(aliceP, b);
    await expect(conversations.pin(aliceP, c)).rejects.toBeInstanceOf(ConflictException);
    await setPolicy({ llmPinnedMax: 1 });
    const pinned = (await conversations.list(aliceP)).items.filter((i) => i.pinned).map((i) => i.id).sort();
    expect(pinned).toEqual([a, b].sort());
    // 고정한 것은 지워지는 시각이 없다
    expect((await conversations.list(aliceP)).items.find((i) => i.id === a)?.expiresAt).toBeNull();
  });

  it('**고정을 풀면 그때부터 N일** — 풀자마자 지워지지 않는다 (FR-1135)', async () => {
    const provider = await registerProvider();
    const id = await conversation(aliceP, provider.id, 'long ago');
    await conversations.pin(aliceP, id);
    await db.update(llmConversations).set({ retainFrom: ago(100) }).where(eq(llmConversations.id, id));
    await conversations.unpin(aliceP, id);
    const item = (await conversations.list(aliceP)).items.find((i) => i.id === id);
    expect(item?.pinned).toBe(false);
    const left = new Date(item?.expiresAt as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(6.9 * 86_400_000);
    // 고정하지 않은 것을 풀어도 기준은 바뀌지 않는다
    await db.update(llmConversations).set({ retainFrom: ago(3) }).where(eq(llmConversations.id, id));
    await conversations.unpin(aliceP, id);
    const again = await db.query.llmConversations.findFirst({ where: eq(llmConversations.id, id) });
    expect(Date.now() - (again?.retainFrom.getTime() ?? 0)).toBeGreaterThan(2.9 * 86_400_000);
  });

  it('지우기는 되살리기가 없고 메시지도 함께 — 남의 것은 404 (FR-1138·1139)', async () => {
    const provider = await registerProvider();
    const id = await conversation(aliceP, provider.id, 'q');
    await expect(conversations.remove(bobP, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(conversations.get(bobP, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(conversations.pin(bobP, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(conversations.unpin(bobP, id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await conversations.list(bobP)).items).toEqual([]);
    await conversations.remove(aliceP, id);
    expect(await db.select().from(llmMessages).where(eq(llmMessages.conversationId, id))).toEqual([]);
  });

  it('목록은 최근 순이고 지워지는 시각을 준다', async () => {
    const provider = await registerProvider();
    const a = await conversation(aliceP, provider.id, 'a');
    const b = await conversation(aliceP, provider.id, 'b');
    await db.update(llmConversations).set({ updatedAt: ago(1), retainFrom: ago(1) }).where(eq(llmConversations.id, a));
    const items = (await conversations.list(aliceP)).items;
    expect(items.map((i) => i.id)).toEqual([b, a]);
    const left = new Date(items[1].expiresAt as string).getTime() - Date.now();
    expect(Math.round(left / 86_400_000)).toBe(6);
  });
});
