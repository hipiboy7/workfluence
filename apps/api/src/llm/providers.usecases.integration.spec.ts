import { ForbiddenException } from '@nestjs/common';
import type { AppEnv } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { auditEvents } from '../db/schema';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import type { LlmClient } from './llm.provider';
import { LlmProviderUseCases } from './providers.usecases';
import { LlmProvidersService } from './providers.service';

/** LLM 연결 등록·삭제의 유스케이스 (P10_설계서_Llm FR-1100~1106 · docs/spinoff/public-api 계획서 7.1절). B등급 — 실제 PostgreSQL */

let db: TestDb;
let uc: LlmProviderUseCases;
const META = { ip: '10.0.0.13' };
const SECRET_KEY = 'k-secret-uc-123';
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
const env = { WF_LLM_MASTER_KEY: randomBytes(32).toString('base64url'), WF_LLM_TIMEOUT_MS: 5_000 } as unknown as AppEnv;
const dto = { name: '사내 Qwen', baseUrl: 'http://llm.example.internal:8000/v1', model: 'mock-qwen3', apiKey: SECRET_KEY };

beforeAll(async () => {
  ({ db } = await openTestDb());
  uc = new LlmProviderUseCases(new LlmProvidersService(db, env, {} as LlmClient), new AuditService(db), db);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('등록', () => {
  it('등록하고 감사에 이름·주소·모델·키 있음만 남긴다 — **키 값은 싣지 않는다** (FR-1102·1106)', async () => {
    const root = await person(db, 'sys', 'root');
    const view = await uc.create(dto, root, META);
    const [r] = await rows('llm.provider.create');
    expect(r).toMatchObject({ actorId: root.id, targetType: 'llm.provider', targetId: view.id, ip: META.ip });
    expect(r!.detail).toEqual({ name: '사내 Qwen', baseUrl: 'http://llm.example.internal:8000/v1', model: 'mock-qwen3', hasKey: true });
    expect(JSON.stringify(r)).not.toContain(SECRET_KEY);
  });

  it('위임받지 않은 사람은 막히고 감사가 남지 않는다', async () => {
    const admin = await person(db, 'adm', 'admin');
    await expect(uc.create(dto, admin, META)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await rows('llm.provider.create')).toHaveLength(0);
  });
});

describe('삭제', () => {
  it('지우고 감사에 무엇이 지워졌는지 남긴다', async () => {
    const root = await person(db, 'sys', 'root');
    const view = await uc.create(dto, root, META);
    await uc.remove(view.id, root, META);
    const [r] = await rows('llm.provider.delete');
    expect(r).toMatchObject({ actorId: root.id, targetId: view.id, ip: META.ip });
    expect(r!.detail).toMatchObject({ name: '사내 Qwen' });
    expect(JSON.stringify(r)).not.toContain(SECRET_KEY);
  });
});
