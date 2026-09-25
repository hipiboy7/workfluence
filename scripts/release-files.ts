import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 묶음 안의 파일 — **하위 디렉토리까지** `/`로 이은 상대 경로로 (`ca/README.md`). 묶기(`release-bundle.ts`)와 검사(`release-verify.ts`)가
 * 같은 목록을 본다.
 *
 * 예전에는 둘 다 맨 위만 봤다(`readdirSync`). 사내 CA 자리(`ca/`, P11 D.7)가 묶음에 들어오면서 하위 파일이 생겼다 — 맨 위만 보면
 * 체크섬이 그 파일을 건너뛰고, 필수 목록의 `ca/README.md`를 "없다"로 판정한다. 디렉토리 자체는 목록에 넣지 않는다
 * (`readFileSync`가 디렉토리에서 `EISDIR`로 터진다). `SHA256SUMS`의 경로는 `sha256sum -c`가 그대로 읽는 모양이다
 */
export function bundleFiles(dir: string, prefix = ''): string[] {
  return readdirSync(prefix ? join(dir, prefix) : dir)
    .sort()
    .flatMap((name) => {
      const rel = prefix ? `${prefix}/${name}` : name;
      return statSync(join(dir, rel)).isDirectory() ? bundleFiles(dir, rel) : [rel];
    });
}
