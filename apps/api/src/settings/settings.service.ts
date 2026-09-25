import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { POLICY_KEYS, SETTINGS_KEYS, applyPolicy, mergePolicy, policyConsistencyProblems, validatePolicyPatch, type Policy, type Principal } from '@workfluence/shared';
import { eq, sql } from 'drizzle-orm';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { settings } from '../db/schema';

/**
 * 운영 정책값 (P4_설계서_Admin C절, FR-520~527).
 *
 * 값의 출처는 세 겹이다. **아래가 위를 덮는다.**
 *
 * ```
 * 1. 코드 기본값   packages/shared/src/policy.ts  ← DB가 비어도 기동한다
 * 2. 환경변수      WF_*                            ← 그 기계의 한계·초기값
 * 3. DB settings   관리 화면이 바꾸는 값            ← 운영 중 조절
 * ```
 *
 * **`uploadMaxMb`만은 환경변수가 천장이다.** multer의 방벽이 기동 시점에 정해지므로
 * DB로 그보다 크게 올려도 요청이 그 앞에서 잘린다 — "바꿨는데 안 먹는" 상태가 되느니
 * 애초에 못 올리게 막는다 (FR-523의 정신).
 */
@Injectable()
export class SettingsService {
  /** 요청마다 DB를 읽지 않는다. 바꾸면 즉시 버린다 (FR-523) */
  private cache: Policy | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
  ) {}

  /** 환경변수가 주는 층. DB에 값이 없을 때의 기본값이다 (FR-527) */
  private fromEnv(): Record<string, unknown> {
    return {
      uploadMaxMb: this.env.WF_UPLOAD_MAX_MB,
      sessionIdleMinutes: this.env.WF_SESSION_IDLE_MINUTES,
      sessionAbsoluteHours: this.env.WF_SESSION_ABSOLUTE_HOURS,
      trashRetentionDays: this.env.WF_TRASH_RETENTION_DAYS,
      auditRetentionDays: this.env.WF_AUDIT_RETENTION_DAYS,
    };
  }

  /** 이 기계가 허용하는 업로드 천장 */
  get uploadCeilingMb(): number {
    return this.env.WF_UPLOAD_MAX_MB;
  }

  async get(tx: Db = this.db): Promise<Policy> {
    // **트랜잭션 안에서는 캐시를 보지 않는다** — 잠금 뒤에 읽는 값(`update`의 `current`)이 캐시의 옛 값이면 "잠금 뒤에 읽는다"가
    // 거짓이 된다 (검토 반영 — 짝 규칙이 옛 값을 보고 지나갔다). `update`만의 일이 아니다: 트랜잭션을 넘기는 호출자 모두(비밀번호 판정·
    // 로그인 실패 잠금·업로드·LLM 대화 저장)가 한 번 더 읽는다. 설정은 한 행이라 비용이 작고, 트랜잭션 안에서는 그 순간의 값이 맞다
    if (tx === this.db && this.cache) return this.cache;
    const row = await tx.query.settings.findFirst({ where: eq(settings.key, SETTINGS_KEYS.policy) });
    const stored = (row?.value as Record<string, unknown> | undefined) ?? {};
    const policy = this.clamp(applyPolicy({ ...this.fromEnv(), ...stored }));
    // **트랜잭션 안에서 읽은 값은 캐시하지 않는다.** 그 트랜잭션이 롤백되면 DB에는 옛값,
    // 메모리에는 새값이 남아 재기동 전까지 어긋난다 (자체 점검 3)
    if (tx === this.db) this.cache = policy;
    return policy;
  }

  /**
   * **읽기에서도 천장을 건다** (자체 점검 5).
   *
   * 쓰기에서만 막으면, DB에 50이 저장된 뒤 `WF_UPLOAD_MAX_MB`를 20으로 내려 재기동했을 때
   * 판정은 50을 쓰고 multer는 20에서 자른다 — FR-528이 막으려던 상태가 다른 문으로 다시 열린다.
   */
  private clamp(p: Policy): Policy {
    return p.uploadMaxMb > this.env.WF_UPLOAD_MAX_MB ? { ...p, uploadMaxMb: this.env.WF_UPLOAD_MAX_MB } : p;
  }

  /** 테스트와 변경 직후에 쓴다. 다음 `get()`이 DB를 다시 읽는다 */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * 정책값 변경. 돌려주는 것은 **바뀐 키의 이전·이후 값**이다 — 감사로그에 그대로 들어간다 (FR-525).
   */
  async update(patch: Record<string, unknown>, principal: Principal, tx: Db = this.db): Promise<{ before: Partial<Policy>; after: Partial<Policy> }> {
    const errors = validatePolicyPatch(patch);
    if (patch.uploadMaxMb !== undefined && typeof patch.uploadMaxMb === 'number' && patch.uploadMaxMb > this.uploadCeilingMb) {
      errors.push(`업로드 상한은 이 서버의 천장(${this.uploadCeilingMb}MB)을 넘을 수 없다. 넘기려면 WF_UPLOAD_MAX_MB를 올리고 다시 띄운다`);
    }
    if (errors.length) throw new BadRequestException(errors.join('; '));

    // **줄을 먼저 세운다** (자체 점검 12). 읽기-병합-쓰기 사이에 다른 관리자가 끼어들면
    // 한쪽 변경이 조용히 사라지고, 감사로그에는 둘 다 남아 기록과 실제가 어긋난다.
    // **`current`도 잠금 뒤에 읽는다** — 앞에서 읽으면 감사로그의 "이전 값"이 남의 변경
    // 이전 값이 되어 되짚을 수 없다 (코드 리뷰 9)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SETTINGS_KEYS.policy}))`);
    const current = await this.get(tx);
    const row = await tx.query.settings.findFirst({ where: eq(settings.key, SETTINGS_KEYS.policy) });
    const stored = (row?.value as Record<string, unknown> | undefined) ?? {};
    const merged = { ...stored, ...patch };
    // **값 둘에 걸친 규칙은 바꾼 뒤의 전체로 본다** (P10 FR-1134). 한쪽만 바꾸는 요청이 있다 — 고정 수만 올리거나 대화 수만
    // 내리면 짝이 어긋난다. **짝을 맞추지 않고 합친 값**(`mergePolicy`)으로 본다 — `applyPolicy`는 읽을 때 조용히 맞추므로 그 값으로
    // 보면 어긋난 값이 판정을 지나 저장된다(검토 반영)
    const consistency = policyConsistencyProblems(mergePolicy({ ...this.fromEnv(), ...merged }));
    if (consistency.length) throw new BadRequestException(consistency.join('; '));

    await tx
      .insert(settings)
      .values({ key: SETTINGS_KEYS.policy, value: merged, updatedBy: principal.id, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: merged, updatedBy: principal.id, updatedAt: new Date() } });

    // **여기서 캐시를 버리지 않는다.** 아직 커밋 전이라, 버린 직후 다른 요청이 `get()`을
    // 부르면 **커밋되지 않은 옛 값**을 읽어 캐시에 굳힌다 — 그러면 DB는 새 값인데 모든
    // 요청이 옛 값을 쓰는, FR-523이 막으려던 바로 그 상태가 된다 (코드 리뷰 2).
    // 무효화는 **커밋 뒤에** 호출부가 한다 (`PolicyController.update`).
    // 다음 값은 캐시를 거치지 않고 계산한다
    const next = this.clamp(applyPolicy({ ...this.fromEnv(), ...merged }));

    const before: Partial<Policy> = {};
    const after: Partial<Policy> = {};
    for (const key of POLICY_KEYS) {
      if (patch[key] === undefined) continue;
      (before as Record<string, unknown>)[key] = current[key];
      (after as Record<string, unknown>)[key] = next[key];
    }
    return { before, after };
  }
}
