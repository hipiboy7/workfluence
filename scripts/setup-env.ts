/**
 * pnpm setup:env — `.env`가 없으면 `.env.example`을 복사한다. 있으면 건드리지 않는다.
 *
 * 왜 스크립트인가: 문서의 실행 명령은 `pnpm <script>` 형태로만 적는다 (`CLAUDE.md` 4.1절).
 * `cp`/`copy`는 OS마다 달라 문서에 적으면 한쪽 독자가 실패한다.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const target = resolve(ROOT, '.env');
const source = resolve(ROOT, '.env.example');

if (existsSync(target)) {
  console.log('.env가 이미 있다. 그대로 둔다.');
} else {
  copyFileSync(source, target);
  console.log('.env를 .env.example에서 만들었다. 값을 채운 뒤 pnpm check:env로 확인한다.');
}
