import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 묶음 안의 파일 — **하위 디렉토리까지** `/`로 이은 상대 경로로 (`ca/README.md`). 묶기(`release-bundle.ts`)와 검사(`release-verify.ts`)가
 * 같은 목록을 본다.
 *
 * 예전에는 둘 다 맨 위만 봤다(`readdirSync`). 사내 CA 자리(`ca/`, P11 D.7)가 묶음에 들어오면서 하위 파일이 생겼다 — 맨 위만 보면
 * 체크섬이 그 파일을 건너뛰고, 필수 목록의 `ca/README.md`를 "없다"로 판정한다. 디렉토리 자체는 목록에 넣지 않는다
 * (`readFileSync`가 디렉토리에서 `EISDIR`로 터진다). `SHA256SUMS`의 경로는 `sha256sum -c`가 그대로 읽는 모양이다.
 *
 * **보통 파일만 담는다 — 심볼릭 링크는 따라가지 않고 목록에서 뺀다**(`lstatSync`). 묶기는 링크를 만들지 않는다. 링크를 따라가면 끊어진
 * 링크(`ENOENT`)나 자기를 가리키는 링크(`ELOOP`)에서 검사가 문제 목록이 아니라 스택으로 죽는다(P11 종료 루틴 자체 점검 4). 필수 파일이
 * 링크로 바뀌어 있으면 "없다"로 나온다 — 묶음이 만든 모양이 아니다
 */
export function bundleFiles(dir: string, prefix = ''): string[] {
  return readdirSync(prefix ? join(dir, prefix) : dir)
    .sort()
    .flatMap((name) => {
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(join(dir, rel));
      if (st.isDirectory()) return bundleFiles(dir, rel);
      return st.isFile() ? [rel] : [];
    });
}
