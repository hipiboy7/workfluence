import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * LLM API 키 암호화 (A등급, P10_설계서_Llm D.4·FR-1102·1103).
 *
 * ```
 * v1.{IV}.{태그}.{암호문}      각 base64url
 * AES-256-GCM · IV 12바이트(넣을 때마다 새로) · AAD = "llm_providers:{행 id}:{주소}"
 * ```
 *
 * **AAD에 행 id와 주소를 묶는다.** DB를 만질 수 있는 사람이 암호문을 다른 행으로 옮겨 붙이거나, **같은 행에서 주소만 바꿔**
 * 풀린 키를 자기 서버로 보내게 하면 풀리지 않는다(주소는 검토 반영 — 보안 검토 2). 주소를 고치는 화면·API는 없으므로 비용이 없다.
 * 판(`v1`)을 앞에 둔다 — 방식을 바꿀 날이 오면 옛 판을 읽는 길을 남긴 채 새 판을 쓴다.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 풀 수 없다 — 마스터 키가 바뀌었거나, 옮겨 붙였거나, 망가졌다. **문장에 평문도 키도 싣지 않는다** (로그로 간다) */
export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

/**
 * `WF_LLM_MASTER_KEY`를 읽는다. 비면 `null` — 키 없는 LLM만 등록된다 (FR-1103).
 * 모양은 기동에서 이미 봤다(`env.ts`). 여기서 32바이트가 아니면 **시끄럽게** 던진다 — 짧은 키로 암호화한 뒤에는 되돌릴 수 없다.
 * Node의 `base64` 풀기는 base64url 글자도 받는다.
 */
export function parseMasterKey(raw: string): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) throw new Error(`WF_LLM_MASTER_KEY는 ${KEY_BYTES}바이트여야 한다 (지금 ${key.length}바이트)`);
  return key;
}

/** 이 행에 묶는 부가 데이터 — 행 id와 **그 키를 보낼 주소** */
export function providerAad(id: string, baseUrl: string): string {
  return `llm_providers:${id}:${baseUrl}`;
}

/** 넣는다. `iv`는 시험을 위한 문이다 — 운영은 늘 새로 뽑는다 */
export function sealSecret(plain: string, key: Buffer, aad: string, iv: Buffer = randomBytes(IV_BYTES)): string {
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** 뺀다. 틀린 키·다른 행·망가진 암호문·모르는 판은 모두 `SecretError`다 */
export function openSecret(sealed: string, key: Buffer, aad: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretError('저장된 API 키의 모양을 모른다');
  const [, ivText, tagText, ctText] = parts;
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  const ct = Buffer.from(ctText, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretError('저장된 API 키의 모양을 모른다');
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // 까닭을 가리지 않는다 — 틀린 키인지 망가진 것인지 말하면 그것이 곧 단서다
    throw new SecretError('저장된 API 키를 풀 수 없다 — 마스터 키가 바뀌었거나 저장된 값이 망가졌다');
  }
}
