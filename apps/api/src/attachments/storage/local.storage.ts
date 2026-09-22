import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { APP_ENV, REPO_ROOT, type AppEnvToken } from '../../config/config.module';
import { blobPath } from '../domain/blob-path';
import type { StorageProvider } from './storage.provider';

/**
 * 로컬 디스크 구현 (P3_설계서_Content 3.1절).
 *
 * `WF_STORAGE_PATH/<앞2자>/<해시>`에 둔다. 앞 두 자로 나누는 것은 한 디렉토리에 파일이
 * 수만 개 쌓이면 디렉토리 조회 자체가 느려지기 때문이다.
 *
 * **경로에 사용자 입력이 닿지 않는다.** 이름은 우리가 계산한 16진수뿐이고, 그것마저
 * 형식을 검사한다. 호출부가 실수해도 `../`가 경로로 들어갈 수 없다.
 */
@Injectable()
export class LocalDiskStorage implements StorageProvider {
  private readonly root: string;

  constructor(@Inject(APP_ENV) env: AppEnvToken) {
    // **상대 경로는 저장소 루트 기준이다** (CLAUDE.md 8.1절 표). `process.cwd()` 기준으로 풀면
    // `pnpm dev`가 api를 `apps/api`에서 띄우므로 `apps/api/.local/attachments`에 쌓인다 —
    // 문서가 가리키는 곳과 다른 데 생기고, 아무도 오류를 보지 못한다 (P3 자체 점검 #2).
    // 컨테이너는 절대 경로(`/data/attachments`)라 이 분기를 타지 않는다
    this.root = isAbsolute(env.WF_STORAGE_PATH) ? env.WF_STORAGE_PATH : resolve(REPO_ROOT, env.WF_STORAGE_PATH);
  }

  /** 자리 계산은 `domain/blob-path.ts` 한 곳이다. 정리 명령도 같은 함수를 쓴다 */
  private pathOf(sha256: string): string {
    return blobPath(this.root, sha256);
  }

  /**
   * **임시 이름으로 다 쓴 뒤 옮긴다.**
   *
   * 곧바로 최종 경로에 쓰면 도중에 죽었을 때(디스크 참·프로세스 종료) **잘린 파일이 그 해시
   * 자리에 남는다.** 그 뒤로는 `has()`가 true라 아무도 다시 쓰지 않아 영구히 고정되고,
   * 다운로드는 오류 없이 잘린 내용을 준다 — 조용히 잘못되는 유형이다 (P3 자체 점검 #1).
   * 같은 파일시스템 안의 `rename`은 원자적이라, 최종 경로에는 **완성된 것만** 나타난다.
   */
  async put(sha256: string, data: Buffer): Promise<void> {
    const p = this.pathOf(sha256);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, p);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  async get(sha256: string): Promise<Buffer> {
    return readFile(this.pathOf(sha256));
  }

  async has(sha256: string): Promise<boolean> {
    // **경로 계산을 try 밖에 둔다.** 안에 두면 형식 검사 실패가 "없다"로 삼켜져,
    // 잘못된 키로 부른 호출부가 조용히 새 파일을 쓰는 쪽으로 흘러간다
    const p = this.pathOf(sha256);
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  async delete(sha256: string): Promise<void> {
    await rm(this.pathOf(sha256), { force: true });
  }
}
