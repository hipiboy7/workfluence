import { ForbiddenException } from '@nestjs/common';
import { DOCUMENT_SCHEMA_VERSION, type DocNode } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { auditEvents } from '../db/schema';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { TemplateUseCases } from './templates.usecases';
import { TemplatesService } from './templates.service';

/** 템플릿의 유스케이스 (P6_설계서_Collab E절 · docs/spinoff/public-api 계획서 7.1절). B등급 — 실제 PostgreSQL */

let db: TestDb;
let uc: TemplateUseCases;
const META = { ip: '10.0.0.10' };
const doc = (t: string): DocNode => ({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));

beforeAll(async () => {
  ({ db } = await openTestDb());
  uc = new TemplateUseCases(new TemplatesService(db), new AuditService(db), db);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('만들기', () => {
  it('새로 만들면 감사에 남긴다', async () => {
    const admin = await person(db, 'adm', 'admin');
    const t = await uc.create({ name: '회의록', content: doc('x') }, admin, META);
    const [r] = await rows('template.create');
    expect(r).toMatchObject({ actorId: admin.id, targetType: 'template', targetId: t.id, ip: META.ip, detail: { name: '회의록' } });
  });

  it('**같은 것을 다시 부르면(멱등) 감사를 더 남기지 않는다** (FR-745·746)', async () => {
    const admin = await person(db, 'adm', 'admin');
    const a = await uc.create({ name: '회의록', content: doc('x') }, admin, META);
    const b = await uc.create({ name: '회의록', content: doc('x') }, admin, META);
    expect(b.id).toBe(a.id);
    expect(await rows('template.create')).toHaveLength(1);
  });

  it('권한이 없으면 막히고 감사가 남지 않는다', async () => {
    const member = await person(db, 'mem');
    await expect(uc.create({ name: 'a', content: doc('x') }, member, META)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await rows('template.create')).toHaveLength(0);
  });
});

describe('고치기·지우기', () => {
  it('고치면 새 이름으로, 지우면 지우기 전의 이름으로 감사를 남긴다', async () => {
    const admin = await person(db, 'adm', 'admin');
    const t = await uc.create({ name: '처음', content: doc('x') }, admin, META);
    const u = await uc.update(t.id, { name: '나중' }, admin, META);
    expect(u.name).toBe('나중');
    expect((await rows('template.update'))[0]).toMatchObject({ targetId: t.id, detail: { name: '나중' }, ip: META.ip });

    await uc.remove(t.id, admin, META);
    expect((await rows('template.delete'))[0]).toMatchObject({ targetId: t.id, detail: { name: '나중' }, ip: META.ip });
  });
});
