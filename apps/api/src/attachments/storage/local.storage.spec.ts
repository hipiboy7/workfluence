import type { AppEnv } from '@workfluence/shared';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage } from './local.storage';

/** B등급. 임시 디렉토리에 실제로 쓰고 읽는다 (P3_설계서_Content 5절) */

let root: string;
let s: LocalDiskStorage;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-store-'));
  s = new LocalDiskStorage({ WF_STORAGE_PATH: root } as unknown as AppEnv);
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('LocalDiskStorage', () => {
  it('넣은 것을 그대로 돌려준다', async () => {
    const h = sha('내용');
    expect(await s.has(h)).toBe(false);
    await s.put(h, Buffer.from('내용'));
    expect(await s.has(h)).toBe(true);
    expect((await s.get(h)).toString()).toBe('내용');
  });

  it('지우면 없어지고, 없는 것을 지워도 오류가 아니다', async () => {
    const h = sha('지울 것');
    await s.put(h, Buffer.from('지울 것'));
    await s.delete(h);
    expect(await s.has(h)).toBe(false);
    await expect(s.delete(h)).resolves.toBeUndefined();
  });

  it('해시가 아닌 이름은 거부한다 — 경로를 만드는 값이라 여기서 한 번 더 막는다 (FR-412)', async () => {
    for (const bad of ['../../etc/passwd', 'abc', `${'a'.repeat(63)}Z`, '']) {
      await expect(s.put(bad, Buffer.from('x'))).rejects.toThrow(/SHA-256/);
      await expect(s.has(bad)).rejects.toThrow(/SHA-256/);
      await expect(s.delete(bad)).rejects.toThrow(/SHA-256/);
    }
  });

  it('앞 두 자로 디렉토리를 나눈다 — 한 디렉토리에 수만 개가 쌓이지 않게', async () => {
    const h = sha('나눔');
    await s.put(h, Buffer.from('나눔'));
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(join(root, h.slice(0, 2), h))).toString()).toBe('나눔');
  });
});
