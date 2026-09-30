import { createHash } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD_RESET, maskEmail, type Principal } from '@workfluence/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { RateLimitStore } from '../common/rate-limit.guard';
import { RevocationBus } from '../common/revocation.bus';
import { loadEnv } from '../config/config.module';
import { auditEvents, notifications, passwordResetTokens, users } from '../db/schema';
import type { MailMessage, MailSender } from '../mail/mail.provider';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { UsersService } from '../users/users.service';
import { AuthController } from './auth.module';
import { AuthService } from './auth.service';
import { RESET_LINK_INVALID, RecoveryService } from './recovery.service';

/**
 * B등급 통합 시험 (P19_설계서_Recovery C절, FR-2000~2012). **실제 PostgreSQL**을 쓴다. 메일 발송만 대역이다 — 보낸 것을 모은다(2절 DIP 표의 알림 발송 축).
 * 시간은 `now`로 넣는다 — 기한·간격을 기다리지 않고 본다
 */

const PUBLIC_URL = 'https://wiki.example.internal';
const ENV = { WF_MAIL_ENABLED: true, WF_PUBLIC_URL: PUBLIC_URL, WF_OIDC_ENABLED: false, WF_COLLAB_ENABLED: true };

/** 보낸 메일을 모으는 발송 — `ok`를 바꾸면 실패를 흉내 낸다 */
class CapturingSender implements MailSender {
  sent: MailMessage[] = [];
  ok = true;
  send(m: MailMessage): Promise<boolean> {
    this.sent.push(m);
    return Promise.resolve(this.ok);
  }
}

let db: TestDb;
let bus: RevocationBus;
let settings: SettingsService;
let usersSvc: UsersService;
let audit: AuditService;
let notifySvc: NotificationsService;
let auth: AuthService;
let sender: CapturingSender;
let recovery: RecoveryService;

const ROOT: Principal = { id: '00000000-0000-0000-0000-000000000000', role: 'root' };
const min = 60_000;

function makeRecovery(env: Partial<typeof ENV> = {}): RecoveryService {
  return new RecoveryService(usersSvc, audit, notifySvc, settings, auth, sender, db, { ...ENV, ...env } as never);
}

beforeAll(async () => {
  ({ db } = await openTestDb());
  bus = new RevocationBus();
  settings = new SettingsService(db, loadEnv());
  usersSvc = new UsersService(db, settings, bus);
  audit = new AuditService(db);
  notifySvc = new NotificationsService(db, new InAppChannel());
  auth = new AuthService(usersSvc, audit, new SpacesService(db), notifySvc, db, ENV as never, null);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  settings.invalidate();
  sender = new CapturingSender();
  recovery = makeRecovery();
});

const PW = 'Alice-pw-2026';
const EMAIL = 'alice@example.internal';

/** 활성 로컬 계정 — 가입하고 승인한다(실제 경로로 해시를 만든다) */
async function addLocal(username = 'alice', displayName = '앨리스', email = EMAIL, role: 'member' | 'admin' | 'root' = 'member') {
  await auth.signup({ username, displayName, email, password: PW });
  const row = (await usersSvc.findByUsername(username))!;
  await usersSvc.approve(row.id, ROOT);
  if (role !== 'member') await db.update(users).set({ role }).where(eq(users.id, row.id));
  return (await usersSvc.findByUsername(username))!;
}

/** 관리자가 운영 설정에서 메일 재설정을 끈다 — 바꾼 사람은 실제 계정이어야 한다(`settings.updated_by`) */
async function policyOff() {
  const admin = await addLocal('policy-admin', '설정 관리자', 'policy-admin@example.internal', 'admin');
  await settings.update({ passwordResetMail: 0 }, { id: admin.id, role: 'admin' });
  settings.invalidate();
}

const tokenOf = (m: MailMessage): string => /#t=([A-Za-z0-9_-]{43})/.exec(m.text)![1];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const auditOf = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action as never));

describe('내 email로 재설정 링크 — 보낸다 (FR-2002·2005)', () => {
  it('**표시 이름 + email이 맞는 member에게 링크 한 통** — 그 계정의 email로, 값은 `#` 뒤, 서버에는 해시만', async () => {
    const alice = await addLocal();
    expect(await recovery.requestResetMail({ displayName: '앨리스', email: EMAIL })).toBe('issued');

    expect(sender.sent).toHaveLength(1);
    const [m] = sender.sent;
    expect(m.to).toBe(EMAIL);
    expect(m.subject).toBe('[위키] 비밀번호 재설정');
    expect(m.text).toContain(`${PUBLIC_URL}/reset-password#t=`);
    const token = tokenOf(m);

    const rows = await db.select().from(passwordResetTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: alice.id, tokenHash: sha(token), passwordMark: sha(alice.passwordHash!) });
    expect(rows[0].expiresAt.getTime() - rows[0].createdAt.getTime()).toBe(PASSWORD_RESET.linkMinutes * min);
    // 값도 링크도 DB 어디에도 없다 — 감사 기록까지
    const dump = JSON.stringify(await db.execute(sql`SELECT row_to_json(a) FROM audit_events a`));
    expect(dump).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(token);

    const [req] = await auditOf('auth.password.reset.request');
    expect(req).toMatchObject({ actorId: alice.id, targetType: 'email', targetId: maskEmail(EMAIL), detail: { found: true, result: 'issued' } });
    const [sent] = await auditOf('mail.send');
    expect(sent).toMatchObject({ actorId: alice.id, detail: { kind: 'password_reset', recipients: 1, sent: 1 } });
  });

  it('**admin도 받는다** · 이름은 앞뒤 빈칸을 뗀 그대로, email은 대소문자를 가리지 않는다(계약이 맞춘다)', async () => {
    await addLocal('boss', '관리자님', 'boss@example.internal', 'admin');
    expect(await recovery.requestResetMail({ displayName: '관리자님', email: 'boss@example.internal' })).toBe('issued');
    expect(sender.sent.map((m) => m.to)).toEqual(['boss@example.internal']);
  });

  it('**맞지 않으면 보내지 않는다** — 이름만 맞거나 email만 맞거나. 감사에는 남는다(`unmatched`)', async () => {
    await addLocal();
    expect(await recovery.requestResetMail({ displayName: '앨리스', email: 'wrong@example.internal' })).toBe('unmatched');
    expect(await recovery.requestResetMail({ displayName: '다른사람', email: EMAIL })).toBe('unmatched');
    expect(sender.sent).toEqual([]);
    expect(await db.select().from(passwordResetTokens)).toEqual([]);
    expect((await auditOf('auth.password.reset.request')).map((r) => (r.detail as { result: string }).result)).toEqual(['unmatched', 'unmatched']);
  });

  it('**root·사내 계정·승인 대기·정지에는 보내지 않는다**(`ineligible`) — 사용자 결정 "root는 제외"', async () => {
    await addLocal('r1', '루트', 'r1@example.internal', 'root');
    await addLocal('off', '정지된', 'off@example.internal');
    await db.update(users).set({ status: 'suspended' }).where(eq(users.username, 'off'));
    await auth.signup({ username: 'wait', displayName: '대기', email: 'wait@example.internal', password: PW });
    await db.insert(users).values({ username: 'idp', displayName: '사내', email: 'idp@example.internal', passwordHash: null, oidcSub: 'sub-1', role: 'member', status: 'active' });

    for (const [displayName, email] of [
      ['루트', 'r1@example.internal'],
      ['정지된', 'off@example.internal'],
      ['대기', 'wait@example.internal'],
      ['사내', 'idp@example.internal'],
    ]) {
      expect(await recovery.requestResetMail({ displayName, email }), displayName).toBe('ineligible');
    }
    expect(sender.sent).toEqual([]);
    expect(await db.select().from(passwordResetTokens)).toEqual([]);
  });

  it('**한 계정에 5분에 한 통** — 그 사이는 보내지 않고(`throttled`) 5분이 지나면 새 링크, 옛 링크는 죽는다 (FR-2003·2004)', async () => {
    await addLocal();
    const t0 = new Date('2026-09-30T01:00:00Z');
    expect(await recovery.requestResetMail({ displayName: '앨리스', email: EMAIL }, undefined, t0)).toBe('issued');
    expect(await recovery.requestResetMail({ displayName: '앨리스', email: EMAIL }, undefined, new Date(t0.getTime() + 4 * min))).toBe('throttled');
    expect(sender.sent).toHaveLength(1);

    const t5 = new Date(t0.getTime() + PASSWORD_RESET.mailIntervalMinutes * min);
    expect(await recovery.requestResetMail({ displayName: '앨리스', email: EMAIL }, undefined, t5)).toBe('issued');
    expect(sender.sent).toHaveLength(2);
    const [first, second] = sender.sent.map(tokenOf);
    expect(first).not.toBe(second);
    // 살아 있는 링크는 하나다 — 옛 값으로는 바꿀 수 없다
    expect((await db.select().from(passwordResetTokens)).map((r) => r.tokenHash)).toEqual([sha(second)]);
    await expect(recovery.resetPassword({ token: first, newPassword: 'New-pw-2026x' }, undefined, t5)).rejects.toThrow(RESET_LINK_INVALID);
  });

  it('**보내기가 실패하면 그 값을 지운다** — 남기면 5분 동안 다시 받을 수 없다. 감사에 `mail.fail`', async () => {
    await addLocal();
    sender.ok = false;
    expect(await recovery.requestResetMail({ displayName: '앨리스', email: EMAIL })).toBe('issued');
    expect(await db.select().from(passwordResetTokens)).toEqual([]);
    expect(await auditOf('mail.fail')).toHaveLength(1);
    sender.ok = true;
    expect(await recovery.requestResetMail({ displayName: '앨리스', email: EMAIL })).toBe('issued');
    expect(await db.select().from(passwordResetTokens)).toHaveLength(1);
  });

  it('**동시에 두 요청이 와도 한 통** — 사용자 행을 잠그고 간격을 본다', async () => {
    await addLocal();
    const r = await Promise.all([1, 2, 3].map(() => recovery.requestResetMail({ displayName: '앨리스', email: EMAIL })));
    expect(r.filter((x) => x === 'issued')).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
    expect(await db.select().from(passwordResetTokens)).toHaveLength(1);
  });
});

describe('링크로 새 비밀번호 (FR-2006·2007)', () => {
  const sessionRow = (sid: string, userId: string) =>
    db.execute(sql`INSERT INTO sessions (sid, sess, expire) VALUES (${sid}, ${JSON.stringify({ userId, cookie: {} })}::jsonb, now() + interval '1 hour')`);
  const sessionsOf = async (userId: string) => (await db.execute(sql`SELECT sid FROM sessions WHERE sess->>'userId' = ${userId}`)).rows.length;

  async function issued(now?: Date) {
    const alice = await addLocal();
    await recovery.requestResetMail({ displayName: '앨리스', email: EMAIL }, undefined, now);
    return { alice, token: tokenOf(sender.sent.at(-1)!) };
  }

  it('**새 비밀번호로 로그인되고 옛 것은 안 된다** — 세션·링크를 모두 지우고, 잠금을 풀고, 변경 강제를 끄고, 편집 연결을 끊는다', async () => {
    const { alice, token } = await issued();
    await sessionRow('stolen-1', alice.id);
    await db.update(users).set({ failedAttempts: 9, lockedUntil: new Date(Date.now() + 10 * min), mustChangePassword: true }).where(eq(users.id, alice.id));
    const revoked: string[] = [];
    const off = bus.onRevoke((id) => revoked.push(id));

    await recovery.resetPassword({ token, newPassword: 'New-pw-2026x' });
    off();

    const after = (await usersSvc.findById(alice.id))!;
    expect(after).toMatchObject({ failedAttempts: 0, lockedUntil: null, mustChangePassword: false });
    await expect(auth.login({ username: 'alice', password: 'New-pw-2026x' })).resolves.toMatchObject({ id: alice.id });
    await expect(auth.login({ username: 'alice', password: PW })).rejects.toThrow();
    expect(await sessionsOf(alice.id)).toBe(0);
    expect(await db.select().from(passwordResetTokens)).toEqual([]);
    expect(revoked).toEqual([alice.id]);
    const [done] = (await auditOf('auth.password.reset')).filter((r) => (r.detail as { ok: boolean }).ok);
    expect(done).toMatchObject({ actorId: alice.id, targetType: 'user', targetId: alice.id });
  });

  it('**새 해시는 그 계정의 줄 안에서 만든다** — 줄 밖에서 만들면 앞선 로그인이 응답 끝에 한 번 더 쓰는 세션 행이 지운 뒤에 되살아난다(P13 D.4 · 병합 전 보안 검토 1)', async () => {
    const { token } = await issued();
    let release!: () => void;
    // 앞선 로그인이 줄을 쥐고 있다
    const held = auth.inAccountLine('alice', () => new Promise<void>((r) => (release = r)));
    const hashed = vi.spyOn(usersSvc, 'preparePassword');
    try {
      const reset = recovery.resetPassword({ token, newPassword: 'New-pw-2026x' });
      await new Promise((r) => setTimeout(r, 300));
      expect(hashed).not.toHaveBeenCalled();
      release();
      await held;
      await reset;
      expect(hashed).toHaveBeenCalledTimes(1);
    } finally {
      hashed.mockRestore();
    }
  });

  it('**한 번만** — 쓴 링크는 같은 400 문장이고 감사에 까닭이 남는다', async () => {
    const { token } = await issued();
    await recovery.resetPassword({ token, newPassword: 'New-pw-2026x' });
    await expect(recovery.resetPassword({ token, newPassword: 'Other-pw-2026' })).rejects.toThrow(new BadRequestException(RESET_LINK_INVALID));
    const fails = (await auditOf('auth.password.reset')).filter((r) => !(r.detail as { ok: boolean }).ok);
    expect(fails.map((r) => (r.detail as { reason: string }).reason)).toEqual(['unknown']);
  });

  it('**동시에 두 번 써도 하나만 된다**', async () => {
    const { alice, token } = await issued();
    // 시험 값은 엔트로피 3.5 아래로 둔다 — `newPassword: '…'`는 gitleaks의 generic-api-key가 읽는다(T-045·T-060·T-094)
    const r = await Promise.allSettled([recovery.resetPassword({ token, newPassword: 'First-pw-2026' }), recovery.resetPassword({ token, newPassword: 'Later-pw-2026' })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    const logins = await Promise.allSettled(['First-pw-2026', 'Later-pw-2026'].map((password) => auth.login({ username: 'alice', password })));
    expect(logins.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await usersSvc.findById(alice.id))!.passwordHash).not.toBe(alice.passwordHash);
  });

  it('**30분이 지나면** 쓰지 못한다(`expired`)', async () => {
    const t0 = new Date();
    const { token } = await issued(t0);
    await expect(recovery.resetPassword({ token, newPassword: 'New-pw-2026x' }, undefined, new Date(t0.getTime() + PASSWORD_RESET.linkMinutes * min))).rejects.toThrow(
      RESET_LINK_INVALID,
    );
    const [f] = await auditOf('auth.password.reset');
    expect(f.detail).toEqual({ ok: false, reason: 'expired' });
  });

  it('**발급 뒤 비밀번호가 바뀌면 죽는다**(`changed`) — 본인 변경·관리자 초기화 어느 길이든', async () => {
    const { alice, token } = await issued();
    await auth.changePassword(alice.id, { currentPassword: PW, newPassword: 'Changed-pw-2026' });
    await expect(recovery.resetPassword({ token, newPassword: 'New-pw-2026x' })).rejects.toThrow(RESET_LINK_INVALID);

    // 관리자 초기화 — 새 링크를 받은 뒤 초기화하면 그 링크도 죽는다
    await recovery.requestResetMail({ displayName: '앨리스', email: EMAIL }, undefined, new Date(Date.now() + 10 * min));
    const second = tokenOf(sender.sent.at(-1)!);
    await usersSvc.resetPassword(alice.id, ROOT);
    await expect(recovery.resetPassword({ token: second, newPassword: 'New-pw-2026x' }, undefined, new Date(Date.now() + 11 * min))).rejects.toThrow(RESET_LINK_INVALID);
    expect((await auditOf('auth.password.reset')).map((r) => (r.detail as { reason: string }).reason)).toEqual(['changed', 'changed']);
  });

  it('**그 사이 받을 수 없는 계정이 되면**(정지·root) 쓰지 못한다(`ineligible`)', async () => {
    const { alice, token } = await issued();
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, alice.id));
    await expect(recovery.resetPassword({ token, newPassword: 'New-pw-2026x' })).rejects.toThrow(RESET_LINK_INVALID);
    await db.update(users).set({ status: 'active', role: 'root' }).where(eq(users.id, alice.id));
    await expect(recovery.resetPassword({ token, newPassword: 'New-pw-2026x' })).rejects.toThrow(RESET_LINK_INVALID);
    expect((await usersSvc.findById(alice.id))!.passwordHash).toBe(alice.passwordHash);
  });

  it('**약한 새 비밀번호는 링크를 쓰지 않고 돌려보낸다** — 살아 있는 정책으로 보고(FR-521), 다시 누르면 된다', async () => {
    const { token } = await issued();
    await expect(recovery.resetPassword({ token, newPassword: 'alllowercase' })).rejects.toThrow(BadRequestException);
    await expect(recovery.resetPassword({ token, newPassword: 'alllowercase' })).rejects.not.toThrow(RESET_LINK_INVALID);
    expect(await db.select().from(passwordResetTokens)).toHaveLength(1);
    await recovery.resetPassword({ token, newPassword: 'New-pw-2026x' });
    await expect(auth.login({ username: 'alice', password: 'New-pw-2026x' })).resolves.toBeDefined();
  });

  it('**그 사람의 남은 계정 찾기 알림을 읽음으로** — 관리자가 뒤늦게 초기화해 방금 정한 비밀번호를 덮지 않게(A.1-10)', async () => {
    const { alice, token } = await issued();
    await addLocal('root1', '루트', 'root1@example.internal', 'root');
    const root = (await usersSvc.findByUsername('root1'))!;
    expect(await notifySvc.notifyPasswordResetRequest({ id: alice.id, role: 'member', grants: [] })).toBe(1);
    expect(await notifySvc.notifyEmailHelpRequest({ id: alice.id })).toBe(1);
    expect(await notifySvc.unreadCount({ id: root.id, role: 'root' })).toBe(2);
    await recovery.resetPassword({ token, newPassword: 'New-pw-2026x' });
    expect(await notifySvc.unreadCount({ id: root.id, role: 'root' })).toBe(0);
  });

  it('**맞지 않는 값은 DB에 없는 값과 같다**(`unknown`) — 누구의 것인지 남기지 않는다', async () => {
    await expect(recovery.resetPassword({ token: 'Z'.repeat(43), newPassword: 'New-pw-2026x' })).rejects.toThrow(RESET_LINK_INVALID);
    const [f] = await auditOf('auth.password.reset');
    expect(f).toMatchObject({ actorId: null, targetId: null, detail: { ok: false, reason: 'unknown' } });
  });
});

describe('"이메일이 기억이 안나시나요?" — 시스템 관리자에게 확인 요청 (FR-2009)', () => {
  const helpRows = () => db.select().from(notifications).where(eq(notifications.kind, 'email.confirm.request'));

  it('**아이디 + 표시 이름이 맞으면 활성 시스템 관리자(자기 제외)에게만** — 관리자에게는 가지 않는다. 맞지 않으면 아무에게도', async () => {
    const alice = await addLocal();
    const r1 = await addLocal('root1', '루트1', 'root1@example.internal', 'root');
    await addLocal('root2', '루트2', 'root2@example.internal', 'root');
    await db.update(users).set({ status: 'suspended' }).where(eq(users.username, 'root2'));
    await addLocal('admin1', '관리', 'admin1@example.internal', 'admin');

    expect(await recovery.requestEmailHelp({ username: 'alice', displayName: '다른사람' })).toBe(0);
    expect(await recovery.requestEmailHelp({ username: 'nobody', displayName: '앨리스' })).toBe(0);
    expect(await helpRows()).toEqual([]);

    expect(await recovery.requestEmailHelp({ username: 'alice', displayName: '앨리스' })).toBe(1);
    const rows = await helpRows();
    expect(rows.map((r) => [r.userId, r.actorId])).toEqual([[r1.id, alice.id]]);

    // 시스템 관리자는 누구의 요청인지 본다 — 사용자 관리에서 찾을 아이디까지
    const [n] = await notifySvc.list({ id: r1.id, role: 'root' }, 10);
    expect(n).toMatchObject({ kind: 'email.confirm.request', actorName: '앨리스', actorUsername: 'alice', pageId: null });
    const audits = await auditOf('auth.email.help');
    expect(audits.map((a) => (a.detail as { found: boolean }).found)).toEqual([false, false, true]);
    expect(audits[2]).toMatchObject({ actorId: alice.id, targetType: 'username', targetId: 'alice' });
  });

  it('**읽지 않은 같은 요청은 또 만들지 않는다** · 요청한 사람이 root면 다른 root에게 간다 · 사내 계정은 알리지 않는다', async () => {
    const alice = await addLocal();
    const r1 = await addLocal('root1', '루트1', 'root1@example.internal', 'root');
    const r2 = await addLocal('root2', '루트2', 'root2@example.internal', 'root');
    expect(await recovery.requestEmailHelp({ username: 'alice', displayName: '앨리스' })).toBe(2);
    expect(await recovery.requestEmailHelp({ username: 'alice', displayName: '앨리스' })).toBe(0);
    expect(await recovery.requestEmailHelp({ username: 'root1', displayName: '루트1' })).toBe(1);
    expect((await helpRows()).filter((r) => r.actorId === r1.id).map((r) => r.userId)).toEqual([r2.id]);

    await db.insert(users).values({ username: 'idp', displayName: '사내', email: 'idp@example.internal', passwordHash: null, oidcSub: 'sub-1', role: 'member', status: 'active' });
    expect(await recovery.requestEmailHelp({ username: 'idp', displayName: '사내' })).toBe(0);
    expect((await helpRows()).filter((r) => r.actorId === alice.id)).toHaveLength(2);
  });

  it('**지금 root일 때만 보인다** — 관리자에서도, root에서 내려가도 목록과 안 읽은 수에 없다', async () => {
    const alice = await addLocal();
    const r1 = await addLocal('root1', '루트1', 'root1@example.internal', 'root');
    await recovery.requestEmailHelp({ username: 'alice', displayName: '앨리스' });
    expect(await notifySvc.unreadCount({ id: r1.id, role: 'root' })).toBe(1);
    expect(await notifySvc.unreadCount({ id: r1.id, role: 'admin' })).toBe(0);
    expect(await notifySvc.list({ id: r1.id, role: 'admin' }, 10)).toEqual([]);
    expect(await notifySvc.unreadCount({ id: r1.id, role: 'member' })).toBe(0);
    // 관리자 초기화도 읽음으로 한다 — 같은 문제의 요청이다(C.5)
    await usersSvc.resetPassword(alice.id, ROOT);
    await notifySvc.resolveRecoveryRequests(alice.id);
    expect(await notifySvc.unreadCount({ id: r1.id, role: 'root' })).toBe(0);
  });
});

describe('쓸 수 있는가 (FR-2008) — 메일 켜짐 · 공개 주소 · 운영 설정', () => {
  it('셋이 다 있으면 쓴다 — 운영 설정으로 끄면 쓰지 않는다(기본 켬)', async () => {
    expect(await recovery.available()).toBe(true);
    await policyOff();
    expect(await recovery.available()).toBe(false);
  });

  it('메일이 꺼져 있거나 공개 주소가 없으면 쓰지 않는다', async () => {
    expect(await makeRecovery({ WF_MAIL_ENABLED: false }).available()).toBe(false);
    expect(await makeRecovery({ WF_PUBLIC_URL: '' }).available()).toBe(false);
  });
});

describe('경로 — 응답은 곧바로, 늘 같다 (NFR-191)', () => {
  const req = { ip: '127.0.0.1' } as unknown as Request;
  const controller = (r: RecoveryService) => new AuthController(auth, ENV as never, new RateLimitStore(), bus, settings, r);

  it('**요청은 일을 기다리지 않는다** — 맞든 틀리든 `{ok: true}`, 메일은 그 뒤에 간다', async () => {
    await addLocal();
    const c = controller(recovery);
    await expect(c.resetMail({ displayName: '앨리스', email: EMAIL }, req)).resolves.toEqual({ ok: true });
    await expect(c.resetMail({ displayName: '누구', email: 'x@example.internal' }, req)).resolves.toEqual({ ok: true });
    expect(c.emailHelp({ username: 'alice', displayName: '앨리스' }, req)).toEqual({ ok: true });
    await vi.waitFor(() => expect(sender.sent).toHaveLength(1), { timeout: 5000 });
    await expect(c.config()).resolves.toMatchObject({ resetMailEnabled: true });
  });

  it('**쓰지 않으면 404** — 요청도, 이미 보낸 링크도(A.1-9). 화면은 단추를 보이지 않는다', async () => {
    await addLocal();
    await recovery.requestResetMail({ displayName: '앨리스', email: EMAIL });
    const token = tokenOf(sender.sent[0]);
    await policyOff();
    const c = controller(recovery);
    await expect(c.resetMail({ displayName: '앨리스', email: EMAIL }, req)).rejects.toThrow(NotFoundException);
    await expect(c.resetPassword({ token, newPassword: 'New-pw-2026x' }, req)).rejects.toThrow(NotFoundException);
    await expect(c.config()).resolves.toMatchObject({ resetMailEnabled: false });
    // 링크는 지워지지 않았다 — 다시 켜면 기한 안에서 쓴다
    expect(await db.select().from(passwordResetTokens).where(and(eq(passwordResetTokens.tokenHash, sha(token))))).toHaveLength(1);
  });
});
