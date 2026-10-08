import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApi, toSortedYaml, V1_OPENAPI_INFO, V1_OPERATIONS } from '@workfluence/shared';

/**
 * 공개 API 명세를 정렬한 YAML 파일로 쓴다 (docs/spinoff/public-api 설계서 3.3-1절). 명세는 경로 표(`V1_OPERATIONS`)에서 코드가 만든다 —
 * 이 파일은 그 **복사본**이라 diff로 명세의 변화를 본다. 단일 출처는 코드다.
 *
 * - `pnpm api:spec` — 파일을 지금 코드의 명세로 고쳐 쓴다. 경로·입력·응답을 바꾼 뒤 한 번 부른다.
 * - `pnpm api:spec --check` — 파일이 지금 코드와 같은지만 본다. 다르면 실패한다. `pnpm check`가 이것을 부른다 — 안 고치고 커밋하면 걸린다.
 */
const FILE = resolve(__dirname, '..', 'docs', 'spinoff', 'public-api', 'openapi.yaml');
const want = toSortedYaml(buildOpenApi(V1_OPERATIONS, V1_OPENAPI_INFO));

if (process.argv.includes('--check')) {
  const have = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
  if (have !== want) {
    console.error('api:spec — docs/spinoff/public-api/openapi.yaml이 지금 코드의 명세와 다르다. `pnpm api:spec`을 불러 고쳐 쓰고 함께 커밋한다.');
    process.exit(1);
  }
  console.log('api:spec — openapi.yaml이 지금 코드의 명세와 같다');
} else {
  writeFileSync(FILE, want);
  console.log(`api:spec — ${FILE} (${want.split('\n').length - 1}줄)`);
}
