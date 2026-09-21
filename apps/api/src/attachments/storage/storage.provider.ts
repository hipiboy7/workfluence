/**
 * 첨부 저장소 경계 (P3_설계서_Content 3.1절, FR-410).
 *
 * `설계서_Architecture` 6절의 **교체 가능 축**이다. 지금은 로컬 디스크이고, MinIO·S3는 이
 * 인터페이스 뒤에 갈아 끼운다. 상위 로직은 구체 구현을 import하지 않는다 (CLAUDE.md 2절 DIP).
 */
export const STORAGE = Symbol('STORAGE');

export interface StorageProvider {
  put(sha256: string, data: Buffer): Promise<void>;
  get(sha256: string): Promise<Buffer>;
  has(sha256: string): Promise<boolean>;
  delete(sha256: string): Promise<void>;
}

/**
 * 스캔 훅 (P3_설계서_Content 3.3절, FR-418, 보류 3).
 *
 * 기본 구현은 통과시킨다. **확인 필요 B가 답을 주면 여기에 ClamAV를 끼운다.**
 * 훅 지점을 지금 두는 이유는 나중에 호출부를 찾아 헤매지 않기 위해서다.
 */
export const SCANNER = Symbol('SCANNER');

export interface AttachmentScanner {
  scan(data: Buffer, filename: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export class PassThroughScanner implements AttachmentScanner {
  async scan(): Promise<{ ok: true }> {
    return { ok: true };
  }
}
