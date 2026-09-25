import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  LLM_TIMINGS,
  can,
  type CreateLlmProviderDto,
  type LlmCheckView,
  type LlmProviderAdminView,
  type LlmProviderView,
  type Principal,
} from '@workfluence/shared';
import { asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { llmProviders, users, type LlmProviderRow } from '../db/schema';
import { SecretError, openSecret, parseMasterKey, providerAad, sealSecret } from './domain/secret';
import { LLM_CLIENT, LlmError, type LlmClient, type LlmTarget } from './llm.provider';

/**
 * 등록한 사내 LLM (P10_설계서_Llm C.1, FR-1100~1108).
 *
 * 등록·삭제·연결 확인은 **root만**(`system.manage`, A.1-1). 가드가 먼저 막고 서비스도 한 번 더 본다 — 다른 호출부가 생겨도
 * 권한이 따라가게(템플릿의 `assertAdmin`과 같은 모양).
 *
 * API 키는 `WF_LLM_MASTER_KEY`로 암호화해 넣고 **어디로도 다시 내보내지 않는다**(FR-1102). 푸는 것은 요청을 보낼 때뿐이다.
 */
@Injectable()
export class LlmProvidersService {
  private readonly masterKey: Buffer | null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_ENV) env: AppEnvToken,
    @Inject(LLM_CLIENT) private readonly client: LlmClient,
  ) {
    this.masterKey = parseMasterKey(env.WF_LLM_MASTER_KEY);
  }

  private assertSystem(principal: Principal): void {
    if (!can(principal, 'system.manage')) throw new ForbiddenException('LLM 등록은 시스템 관리자만 한다');
  }

  /** 일반 사용자에게 — 이름과 모델만 (FR-1107). 주소는 사내 호스트 정보다 */
  async list(): Promise<LlmProviderView[]> {
    const rows = await this.db
      .select({ id: llmProviders.id, name: llmProviders.name, model: llmProviders.model })
      .from(llmProviders)
      .orderBy(asc(llmProviders.name));
    return rows;
  }

  /** 관리 화면에게 — 주소·키 유무·만든 사람까지. **키 자체는 싣지 않는다** */
  async listAdmin(principal: Principal): Promise<LlmProviderAdminView[]> {
    this.assertSystem(principal);
    const rows = await this.db
      .select({ p: llmProviders, createdByName: users.displayName })
      .from(llmProviders)
      .leftJoin(users, eq(users.id, llmProviders.createdBy))
      .orderBy(asc(llmProviders.name));
    return rows.map((r) => toAdminView(r.p, r.createdByName ?? ''));
  }

  /**
   * 등록 (FR-1100·1103·1108). **마스터 키가 없으면 키가 있는 등록을 거부한다** — 조용히 평문으로 넣지 않는다.
   * 같은 이름이면 409 — 같은 이름에 다른 주소가 조용히 무시되면 관리자가 틀린 것을 믿는다.
   */
  async create(dto: CreateLlmProviderDto, principal: Principal, tx: Db = this.db): Promise<LlmProviderAdminView> {
    this.assertSystem(principal);
    if (dto.apiKey && !this.masterKey) {
      throw new BadRequestException('WF_LLM_MASTER_KEY가 없어 API 키를 저장할 수 없다 — 키 없이 등록하거나, 마스터 키를 설정하고 앱을 다시 띄운다');
    }
    // id를 먼저 만든다 — 암호문의 AAD에 묶는다 (D.4)
    const id = randomUUID();
    const apiKeyEnc = dto.apiKey && this.masterKey ? sealSecret(dto.apiKey, this.masterKey, providerAad(id)) : null;
    const [row] = await tx
      .insert(llmProviders)
      .values({ id, name: dto.name, baseUrl: dto.baseUrl, model: dto.model, apiKeyEnc, createdBy: principal.id })
      .onConflictDoNothing({ target: llmProviders.name })
      .returning();
    if (!row) throw new ConflictException('같은 이름의 LLM이 이미 있다');
    const creator = await tx.query.users.findFirst({ where: eq(users.id, principal.id), columns: { displayName: true } });
    return toAdminView(row, creator?.displayName ?? '');
  }

  /**
   * 삭제 (FR-1101). 그 LLM으로 한 대화는 남는다 — `provider_id`가 비워질 뿐이다(`SET NULL`).
   * 돌려주는 것은 감사로그에 적을 것이다 — 키는 없다.
   */
  async remove(id: string, principal: Principal, tx: Db = this.db): Promise<{ name: string; model: string; baseUrl: string; hasKey: boolean }> {
    this.assertSystem(principal);
    const [row] = await tx.delete(llmProviders).where(eq(llmProviders.id, id)).returning();
    if (!row) throw new NotFoundException('LLM을 찾을 수 없다');
    return { name: row.name, model: row.model, baseUrl: row.baseUrl, hasKey: row.apiKeyEnc !== null };
  }

  /**
   * 부를 곳을 만든다 — 키를 여기서 **푼다**(요청 하나 동안만). 없으면 404, 풀 수 없으면 503.
   * 풀 수 없는 것은 마스터 키가 바뀌었거나 저장된 값이 망가진 것이다 — 지우고 다시 등록하는 길을 말한다 (D.4).
   */
  async resolve(id: string): Promise<{ provider: LlmProviderRow; target: LlmTarget }> {
    const provider = await this.db.query.llmProviders.findFirst({ where: eq(llmProviders.id, id) });
    if (!provider) throw new NotFoundException('LLM을 찾을 수 없다 — 지워졌을 수 있다');
    return { provider, target: this.targetOf(provider) };
  }

  private targetOf(provider: LlmProviderRow): LlmTarget {
    let apiKey: string | null = null;
    if (provider.apiKeyEnc) {
      if (!this.masterKey) throw new ServiceUnavailableException('이 LLM의 API 키를 풀 수 없다 — WF_LLM_MASTER_KEY가 없다. 관리자가 마스터 키를 설정하거나 LLM을 지우고 다시 등록한다');
      try {
        apiKey = openSecret(provider.apiKeyEnc, this.masterKey, providerAad(provider.id));
      } catch (e) {
        if (!(e instanceof SecretError)) throw e;
        throw new ServiceUnavailableException('이 LLM의 API 키를 풀 수 없다 — 마스터 키가 바뀌었다. 관리자가 LLM을 지우고 다시 등록한다');
      }
    }
    return { baseUrl: provider.baseUrl, model: provider.model, apiKey };
  }

  /**
   * 연결 확인 (FR-1105) — `GET {주소}/models`. **실패도 응답이다**(`ok: false`와 까닭) — 관리 화면이 그대로 보여 준다.
   * 등록한 모델이 목록에 있는지도 본다 — 주소는 맞는데 모델 이름을 틀리게 적은 것을 질문 전에 안다.
   */
  async check(id: string, principal: Principal): Promise<LlmCheckView> {
    this.assertSystem(principal);
    let resolved: { provider: LlmProviderRow; target: LlmTarget };
    try {
      resolved = await this.resolve(id);
    } catch (e) {
      if (e instanceof ServiceUnavailableException) return { ok: false, message: e.message };
      throw e;
    }
    try {
      const models = await this.client.listModels(resolved.target, AbortSignal.timeout(LLM_TIMINGS.checkTimeoutMs));
      return { ok: true, models, modelFound: models.includes(resolved.provider.model) };
    } catch (e) {
      if (e instanceof LlmError) return { ok: false, message: e.kind === 'timeout' ? `${LLM_TIMINGS.checkTimeoutMs / 1000}초 안에 답이 없다` : e.message };
      throw e;
    }
  }
}

function toAdminView(row: LlmProviderRow, createdByName: string): LlmProviderAdminView {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    baseUrl: row.baseUrl,
    hasKey: row.apiKeyEnc !== null,
    createdByName,
    createdAt: row.createdAt.toISOString(),
  };
}
