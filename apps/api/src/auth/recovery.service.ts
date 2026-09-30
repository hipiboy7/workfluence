import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  PASSWORD_RESET,
  canResetPasswordByMail,
  maskEmail,
  type EmailHelpDto,
  type RecoverPasswordDto,
  type ResetPasswordDto,
  type Role,
  type UserStatus,
} from '@workfluence/shared';
import { and, desc, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { logLine } from '../common/log-line';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { passwordResetTokens, users, type UserRow } from '../db/schema';
import { MAIL_SENDER, type MailSender } from '../mail/mail.provider';
import { passwordResetMail } from '../mail/domain/compose';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { afterSuccess } from './domain/lockout';
import { linkExpiresAt, mailThrottled, newResetToken, passwordMark, resetLinkProblem, resetLinkUrl, resetMailAvailable, tokenDigest } from './domain/reset-link';

/** 틀린 링크는 **하나의 문장**이다 (FR-2007) — 없는 값·지난 값·쓴 값·비밀번호가 바뀐 뒤의 값·받을 수 없게 된 계정. 까닭은 감사에만 남는다 */
export const RESET_LINK_INVALID = '링크가 맞지 않거나 기한이 지났다 — 비밀번호 찾기에서 다시 요청한다';

/** 메일 재설정 요청의 결과 — 감사의 `result`다(FR-2010). 응답은 늘 같다 */
export type ResetMailResult = 'issued' | 'throttled' | 'ineligible' | 'unmatched';

/** 받을 수 있는 계정인가 — 비밀번호가 있는 로컬 계정이고 공유 규칙이 받는다(`canResetPasswordByMail`) */
const eligible = (u: UserRow): boolean =>
  u.passwordHash !== null && canResetPasswordByMail({ role: u.role as Role, status: u.status as UserStatus, local: u.oidcSub === null });

/**
 * **비밀번호를 잊었을 때** — 내 email로 재설정 링크, 링크로 새 비밀번호, email이 기억나지 않을 때 시스템 관리자에게 확인 요청 (P19_설계서_Recovery C절).
 * B등급 — 실제 PostgreSQL로 시험한다. 판정(값·기한·간격·까닭)은 `domain/reset-link.ts`(A등급)가 한다.
 *
 * - **응답은 계정과 무관하다**(NFR-191). 요청(`startResetMail`·`startEmailHelp`)은 곧바로 돌아가고 일은 응답 뒤에 돈다 — 걸린 시간이 "그런 계정이 있다"를
 *   말하지 않게. 시험은 일 자체(`requestResetMail`·`requestEmailHelp`)를 기다린다
 * - 관리자에게 초기화 요청은 `AuthService.recoverPassword` 그대로다 — 조건만 표시 이름 + email로 바뀌었다(FR-2000)
 */
@Injectable()
export class RecoveryService {
  private readonly log = new Logger('Auth');

  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly auth: AuthService,
    @Inject(MAIL_SENDER) private readonly sender: MailSender,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
  ) {}

  /** 메일 재설정을 쓸 수 있는가 (FR-2008) — 메일 켜짐 · 공개 주소 · 운영 설정. 화면의 단추와 두 경로의 404가 이것 하나를 본다 */
  async available(): Promise<boolean> {
    const policy = await this.settings.get();
    return resetMailAvailable({ mailEnabled: this.env.WF_MAIL_ENABLED, publicUrl: this.env.WF_PUBLIC_URL, policy: policy.passwordResetMail });
  }

  /** 요청을 받고 곧바로 돌아간다 — 일은 응답 뒤에 (NFR-191). 실패는 우리 쪽 결함이라 error 한 줄(FR-2012) */
  startResetMail(dto: RecoverPasswordDto, ip?: string): void {
    void this.requestResetMail(dto, ip).catch((e: unknown) => {
      this.log.error(logLine('auth.reset_mail_failed', '비밀번호 재설정 메일을 처리하지 못했다', {}, e));
    });
  }

  /**
   * **내 email로 재설정 링크** (FR-2002~2005). 표시 이름 + email이 맞고 받을 수 있는 계정이면(`canResetPasswordByMail`) 링크 한 통.
   *
   * 사용자 행을 **잠그고** 다시 본다 — 동시에 두 요청이 와도 한 통이고(간격 판정과 쓰기 사이가 벌어지지 않게), 그 사이 정지됐으면 보내지 않는다. 한 사람에게
   * 살아 있는 링크는 하나다 — 그 사람의 옛 행을 지우고 넣는다(기한이 지난 남의 행도 함께 지운다). 메일은 **커밋한 뒤에** 보낸다 — 되돌릴 수 없다(P6 FR-754).
   * 보내기가 실패하면 그 값을 지운다 — 남기면 간격 동안 다시 받을 수 없다(A.1-7)
   */
  async requestResetMail(dto: RecoverPasswordDto, ip?: string, now: Date = new Date()): Promise<ResetMailResult> {
    const found = await this.users.findByEmailAndName(dto.email, dto.displayName);
    const target = { targetType: 'email', targetId: maskEmail(dto.email), ip };
    if (!found || !eligible(found)) {
      const result: ResetMailResult = found ? 'ineligible' : 'unmatched';
      await this.audit.record({ action: 'auth.password.reset.request', actorId: found?.id ?? null, ...target, detail: { found: !!found, result } });
      return result;
    }

    const token = newResetToken(randomBytes(PASSWORD_RESET.tokenBytes));
    // 쓰기와 감사는 **같은 트랜잭션**이다 (P1 FR-236)
    const issued = await this.db.transaction(async (tx) => {
      const decide = async (): Promise<{ result: 'ineligible' | 'throttled' } | { result: 'issued'; user: UserRow; email: string; rowId: string }> => {
        const user = await this.users.lockForUpdate({ id: found.id }, tx);
        if (!user || !eligible(user) || !user.email) return { result: 'ineligible' };
        const [last] = await tx
          .select({ createdAt: passwordResetTokens.createdAt })
          .from(passwordResetTokens)
          .where(eq(passwordResetTokens.userId, user.id))
          .orderBy(desc(passwordResetTokens.createdAt))
          .limit(1);
        if (mailThrottled(last?.createdAt ?? null, now)) return { result: 'throttled' };
        await tx.delete(passwordResetTokens).where(or(eq(passwordResetTokens.userId, user.id), lt(passwordResetTokens.expiresAt, now)));
        const [row] = await tx
          .insert(passwordResetTokens)
          .values({ userId: user.id, tokenHash: tokenDigest(token), passwordMark: passwordMark(user.passwordHash!), createdAt: now, expiresAt: linkExpiresAt(now) })
          .returning({ id: passwordResetTokens.id });
        return { result: 'issued', user, email: user.email, rowId: row.id };
      };
      const r = await decide();
      await this.audit.record({ action: 'auth.password.reset.request', actorId: found.id, ...target, detail: { found: true, result: r.result } }, tx);
      return r;
    });
    if (issued.result !== 'issued') return issued.result;

    const url = resetLinkUrl(this.env.WF_PUBLIC_URL, token);
    // 공개 주소가 없으면 여기 오지 않는다(`available`) — 그래도 링크 없는 메일은 보내지 않는다
    const ok = url !== null && (await this.sender.send({ to: issued.email, ...passwordResetMail({ name: issued.user.displayName, url, minutes: PASSWORD_RESET.linkMinutes }) }));
    if (!ok) await this.db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, issued.rowId));
    // 결과를 감사에 — "메일이 안 왔다"에 답한다(P6 FR-756). 주소는 싣지 않는다
    await this.audit.record({
      action: ok ? 'mail.send' : 'mail.fail',
      actorId: found.id,
      targetType: 'user',
      targetId: found.id,
      detail: { recipients: 1, sent: ok ? 1 : 0, kind: 'password_reset' },
    });
    return 'issued';
  }

  /**
   * **링크로 새 비밀번호를 정한다** (FR-2006·2007). 틀린 링크는 하나의 400 문장이고 까닭은 감사에 남는다.
   *
   * 세기는 살아 있는 정책으로 보고(FR-521) 해시는 트랜잭션 밖에서 만든다(P13 FR-1434) — 약한 비밀번호는 링크를 쓰지 않고 돌려보낸다(다시 누를 수 있게).
   * 그 계정의 **로그인 줄 안에서**: 값을 지우고(한 번 — 동시에 두 번 써도 하나만 지운다), 읽은 비밀번호 그대로이고 여전히 받을 수 있는 계정일 때만 바꾸고,
   * 잠금을 풀고 변경 강제를 끄고, 그 사람의 링크·세션을 모두 지우고, 남은 계정 찾기 알림을 읽음으로. 편집 연결은 커밋한 뒤에 끊는다(P13 D.5)
   */
  async resetPassword(dto: ResetPasswordDto, ip?: string, now: Date = new Date()): Promise<void> {
    const digest = tokenDigest(dto.token);
    const link = await this.db.query.passwordResetTokens.findFirst({ where: eq(passwordResetTokens.tokenHash, digest) });
    const user = link ? await this.users.findById(link.userId) : undefined;
    const problem = !link ? 'unknown' : !user ? 'ineligible' : resetLinkProblem(link, { ...user, role: user.role as Role, status: user.status as UserStatus }, now);
    if (problem || !user) return this.refuse(problem ?? 'ineligible', user?.id ?? null, ip);

    const nextHash = await this.users.preparePassword(dto.newPassword);
    const done = await this.auth.inAccountLine(user.username, async () => {
      const ok = await this.db.transaction(async (tx) => {
        const [taken] = await tx
          .delete(passwordResetTokens)
          .where(and(eq(passwordResetTokens.tokenHash, digest), gt(passwordResetTokens.expiresAt, now)))
          .returning({ id: passwordResetTokens.id });
        if (!taken) return false;
        // **읽은 비밀번호 그대로이고 여전히 받을 수 있는 계정일 때만** — 줄에 서기 전에 본인 변경·관리자 초기화·정지·root가 됐으면 바꾸지 않는다
        const [changed] = await tx
          .update(users)
          .set({ passwordHash: nextHash, mustChangePassword: false, ...afterSuccess(), updatedAt: now })
          .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash!), eq(users.status, 'active'), ne(users.role, 'root'), isNull(users.oidcSub)))
          .returning({ id: users.id });
        if (!changed) return false;
        await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
        await this.users.destroyAllSessions(user.id, tx);
        await this.notifications.resolveRecoveryRequests(user.id, tx);
        await this.audit.record({ action: 'auth.password.reset', actorId: user.id, targetType: 'user', targetId: user.id, detail: { ok: true }, ip }, tx);
        return true;
      });
      if (ok) this.users.revokeConnections(user.id);
      return ok;
    });
    if (!done) return this.refuse('changed', user.id, ip);
  }

  /** 틀린 링크 — 감사에 까닭을 남기고 하나의 문장으로 거절한다 (FR-2007) */
  private async refuse(reason: string, userId: string | null, ip?: string): Promise<never> {
    await this.audit.record({
      action: 'auth.password.reset',
      actorId: null,
      targetType: userId ? 'user' : null,
      targetId: userId,
      detail: { ok: false, reason },
      ip,
    });
    throw new BadRequestException(RESET_LINK_INVALID);
  }

  /** 요청을 받고 곧바로 돌아간다 — 일은 응답 뒤에 (NFR-191, FR-2012) */
  startEmailHelp(dto: EmailHelpDto, ip?: string): void {
    void this.requestEmailHelp(dto, ip).catch((e: unknown) => {
      this.log.error(logLine('auth.email_help_failed', 'email 확인 요청을 시스템 관리자에게 알리지 못했다', {}, e));
    });
  }

  /**
   * **"이메일이 기억이 안나시나요?"** (FR-2009). 아이디 + 표시 이름이 맞는 **활성 로컬** 계정일 때만 시스템 관리자에게 알린다 — 맞지 않은 요청까지 알리면
   * 누구나 시스템 관리자의 알림함을 채운다(P17 착수 쟁점 2와 같다). 사내 계정은 email을 IdP가 준다 — 여기서 알릴 일이 아니다. 만든 알림 수를 돌려준다
   */
  async requestEmailHelp(dto: EmailHelpDto, ip?: string): Promise<number> {
    const user = await this.users.findByUsername(dto.username);
    const found = !!user && user.displayName === dto.displayName && user.status === 'active' && user.passwordHash !== null && user.oidcSub === null;
    await this.audit.record({ action: 'auth.email.help', actorId: found ? user.id : null, targetType: 'username', targetId: dto.username, detail: { found }, ip });
    if (!found) return 0;
    return this.notifications.notifyEmailHelpRequest({ id: user.id });
  }
}
