import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocNode, Principal } from '@workfluence/shared';
import { DOCUMENT_SCHEMA_VERSION } from '@workfluence/shared';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { TemplatesService } from './templates.service';

/** B등급 통합 — **실제 PostgreSQL** (3절). 권한과 멱등이 이 서비스의 전부다 */

let db: TestDb;
let svc: TemplatesService;
let adminId = '';
let memberId = '';

const doc = (t: string): DocNode => ({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';

async function mkUser(username: string, role: string): Promise<string> {
  const r = await db.execute<{ id: string }>(
    sql`INSERT INTO users (username, display_name, role, status, password_hash) VALUES (${username}, ${username}, ${role}, 'active', ${HASH}) RETURNING id`,
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  ({ db } = await openTestDb());
  svc = new TemplatesService(db);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  adminId = await mkUser('tpl-admin', 'admin');
  memberId = await mkUser('tpl-member', 'member');
});

const admin = (): Principal => ({ id: adminId, role: 'admin' });
const member = (): Principal => ({ id: memberId, role: 'member' });

describe('권한 (FR-743)', () => {
  it('관리자만 만든다', async () => {
    await expect(svc.create({ name: 'a', content: doc('x') }, member())).rejects.toBeInstanceOf(ForbiddenException);
    const r = await svc.create({ name: 'a', content: doc('x') }, admin());
    expect(r.created).toBe(true);
  });

  it('**목록은 누구나 본다** — 새 페이지를 만들 때 골라야 한다', async () => {
    await svc.create({ name: 'a', content: doc('x') }, admin());
    expect((await svc.list()).length).toBe(1);
  });

  it('관리자만 고치고 지운다', async () => {
    const { template } = await svc.create({ name: 'a', content: doc('x') }, admin());
    await expect(svc.update(template.id, { name: 'b' }, member())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.remove(template.id, member())).rejects.toBeInstanceOf(ForbiddenException);
    await svc.remove(template.id, admin());
    expect(await svc.list()).toEqual([]);
  });
});

describe('멱등 (FR-745)', () => {
  it('같은 이름이면 **있던 것을 돌려준다**', async () => {
    const a = await svc.create({ name: '회의록', description: '처음', content: doc('처음') }, admin());
    const b = await svc.create({ name: '회의록', description: '나중', content: doc('나중') }, admin());
    expect(b.created).toBe(false);
    expect(b.template.id).toBe(a.template.id);
  });

  it('**덮어쓰지 않는다** — 멱등과 덮어쓰기는 다른 말이다', async () => {
    await svc.create({ name: '회의록', content: doc('처음') }, admin());
    const b = await svc.create({ name: '회의록', content: doc('나중') }, admin());
    expect(JSON.stringify(b.template.content)).toContain('처음');
    expect(JSON.stringify(b.template.content)).not.toContain('나중');
  });
});

describe('고치기·없는 것', () => {
  it('일부만 줘도 나머지는 그대로다', async () => {
    const { template } = await svc.create({ name: 'a', description: '설명', content: doc('본문') }, admin());
    const up = await svc.update(template.id, { name: 'b' }, admin());
    expect(up.name).toBe('b');
    expect(up.description).toBe('설명');
    expect(JSON.stringify(up.content)).toContain('본문');
  });

  it('없는 것은 404다 — 권한을 본 **뒤에** 찾는다', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    await expect(svc.update(missing, { name: 'x' }, admin())).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove(missing, admin())).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.get(missing)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('저장할 때 `schemaVersion`을 찍는다 — 템플릿도 스스로 어느 스키마인지 말해야 한다', async () => {
    const { template } = await svc.create({ name: 'a', content: { type: 'doc', content: [{ type: 'paragraph' }] } }, admin());
    expect(template.content.attrs?.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
  });
});
