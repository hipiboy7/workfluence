import { Inject, Injectable } from '@nestjs/common';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { APP_ENV, type AppEnvToken } from '../../config/config.module';
import type { StorageProvider } from './storage.provider';

/** 해시가 아닌 이름은 받지 않는다. 경로를 만드는 값이라 **여기서 한 번 더 막는다** (FR-412) */
const SHA256_HEX = /^[0-9a-f]{64}$/;

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
    this.root = resolve(process.cwd(), env.WF_STORAGE_PATH);
  }

  private pathOf(sha256: string): string {
    if (!SHA256_HEX.test(sha256)) throw new Error(`저장소 키가 SHA-256 16진수가 아니다: ${sha256}`);
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  async put(sha256: string, data: Buffer): Promise<void> {
    const p = this.pathOf(sha256);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
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
