/**
 * F-009 — Docker 없이 Windows에서 받아서 풀고 바로 띄워 보는 묶음을 만든다 (백로그 F-009, 체험 가이드 10절).
 *
 * **Windows에서** `pnpm build` 뒤에 돈다 — GitHub의 windows-latest 러너(`.github/workflows/windows-local.yml`). 묶음에 담는 네이티브 파일
 * (argon2, PostgreSQL, node.exe)이 이 스크립트를 돌리는 Windows의 것이어야 해서 Linux에서는 멈춘다.
 *
 * 만드는 폴더 `.local/win-bundle/workfluence/` — 워크플로가 그대로 결과물(artifact)로 올린다:
 * - `시작.cmd` · `멈추기.cmd` · `읽어보기.txt`
 * - `node/` — 이 스크립트를 돌리는 node.exe(러너는 24.21.0 — 운영 이미지와 같다)와 그 LICENSE(없으면 멈춘다)
 * - `app/api/` — `pnpm --filter @workfluence/api deploy --legacy --prod`(운영 이미지와 같은 모양 — `deploy/Dockerfile`), `app/web/dist/`
 * - `app/launcher.mjs`(`scripts/win-launcher.mjs`) · `app/env.example`(`.env.example` — 처음 실행에서 설정 파일을 만든다)
 * - `app/links.json` — api의 node_modules는 pnpm이 폴더 연결로 짠다(Windows는 junction). zip은 연결을 담지 못하고, 연결을 따라 복사하면 pnpm의
 *   배치가 깨진다(패키지가 자기 의존성을 옆자리에서 찾는다). 그래서 연결을 목록으로 적고 지운다 — 여는 스크립트가 시작할 때 다시 만든다
 *   (junction은 관리자 권한 없이 만든다). pnpm의 평평한 배치(`node-linker=hoisted`)로 배포하면 node_modules가 비었다(pnpm 12.4.1, 2026-09-28)
 * - `app/bundle.json` — 묶음 안에서 가장 긴 상대 경로. 여는 스크립트가 풀린 자리의 경로 길이를 견준다. 패키지가 잘못 싣고 나온 시험 도구의
 *   캐시(`node_modules/.vite`)는 뺀다 — 실행에 쓰이지 않고 가장 긴 경로였다(`pruneToolCaches`)
 * - `pgsql/` — `@embedded-postgres/windows-x64`의 PostgreSQL 17과 그것이 쓰는 라이브러리, VC++ 런타임 DLL(사용자 승인 2026-09-28 — Microsoft의 재배포
 *   허용 파일, `CLAUDE.md` 7절의 상용 구성 요소. 앱 폴더에 두면 Windows가 System32보다 먼저 찾는다), 그리고 `COPYRIGHT`(PostgreSQL)·
 *   `THIRD_PARTY_NOTICES.txt`(구성 요소마다 판·라이선스·소스 위치와 원문 — 원문은 `scripts/win-notices/`). 아래 `PG_COMPONENTS`에 없는 파일이
 *   `pgsql/bin`에 있거나 판이 다르면 멈춘다 — 고지 없이 새 라이브러리가 들어가지 않게 한다
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '..');
const out = join(root, '.local', 'win-bundle', 'workfluence');
const notices = join(root, 'scripts', 'win-notices');

/** PostgreSQL 실행 파일이 쓰는 VC++ 런타임 — 있는 것만 옮긴다. 앞의 둘은 반드시 있어야 한다 */
const VC_RUNTIME = ['vcruntime140.dll', 'msvcp140.dll', 'vcruntime140_1.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'concrt140.dll'];

/** Windows 탐색기가 다루는 경로 길이의 끝(MAX_PATH 260 — 끝의 NUL 한 자를 뺀다) */
const MAX_PATH = 259;
/**
 * 묶음 안의 상대 경로가 이보다 길면 멈춘다 — 풀 자리의 경로에 남는 길이가 `C:\Users\<이름>\Downloads\…`(50자 안팎)보다 짧아져
 * 흔한 자리에서 탐색기가 파일을 빠뜨린다. 늘리기 전에 무엇이 길어졌는지 본다(묶는 줄이 가장 긴 경로를 찍는다)
 */
const LONGEST_PATH_LIMIT = 200;

type Component = {
  name: string;
  /** 묶음에 든 판 */
  version: string;
  /** 판을 확인할 파일(`pgsql/bin`) — 파일의 판 정보(ProductVersion)가 `version`으로 시작해야 한다. 판 정보가 없는 구성 요소는 비운다 */
  versionOf?: string;
  license: string;
  /** 이 구성 요소의 파일(`pgsql/bin`·`pgsql/lib`의 이름). `pgsql/lib`의 나머지 `.dll`은 PostgreSQL 모듈로 본다 */
  files: RegExp | null;
  /** `scripts/win-notices/`의 원문 */
  texts: string[];
  source: string;
  note?: string;
};

/**
 * `pgsql/`에 든 것 — `@embedded-postgres/windows-x64@17.10.0-beta.17`을 열어 가져오기 목록(PE import)과 판 정보로 확인했다(2026-09-29).
 * PostgreSQL 실행 파일(postgres·initdb·pg_ctl)은 libintl-9.dll을 **직접 가져온다** — 그 DLL(과 그것이 가져오는 libiconv-2·libwinpthread-1)이
 * 없으면 Windows가 실행 파일을 띄우지 않는다. libcurl·wxWidgets·ICU의 io/tu/testplug·ecpg는 아무 실행 파일도 가져오지 않는다(원래 배포판의 다른 도구용)
 */
const PG_COMPONENTS: Component[] = [
  {
    name: 'PostgreSQL',
    version: '17.10',
    versionOf: 'postgres.exe',
    license: 'PostgreSQL License',
    files: /^(postgres|initdb|pg_ctl)\.exe$|^lib(pq|ecpg|ecpg_compat|pgtypes)\.dll$/i,
    texts: ['postgresql-COPYRIGHT.txt'],
    source: 'https://ftp.postgresql.org/pub/source/v17.10/postgresql-17.10.tar.bz2',
    note: 'pgsql\\lib의 확장 모듈(아래 둘을 뺀 .dll)과 pgsql\\share 포함. Windows 빌드는 EDB의 배포판을 embedded-postgres가 다시 묶은 것이다',
  },
  {
    name: 'OpenSSL',
    version: '3.0.20',
    versionOf: 'libcrypto-3-x64.dll',
    license: 'Apache-2.0',
    files: /^lib(ssl|crypto)-3-x64\.dll$|^lib(ssl|crypto)\.lib$/i,
    texts: ['openssl-LICENSE.txt'],
    source: 'https://github.com/openssl/openssl/releases/tag/openssl-3.0.20',
  },
  {
    name: 'ICU (International Components for Unicode)',
    version: '67.1',
    versionOf: 'icuuc67.dll',
    license: 'ICU License (Unicode)',
    files: /^icu(dt|in|io|tu|uc)67\.dll$|^testplug\.dll$/i,
    texts: ['icu-LICENSE.txt'],
    source: 'https://github.com/unicode-org/icu/releases/tag/release-67-1',
    note: 'testplug.dll은 ICU 빌드의 시험용 플러그인이다',
  },
  { name: 'zlib', version: '1.3.2', versionOf: 'zlib1.dll', license: 'Zlib', files: /^zlib1\.dll$/i, texts: ['zlib-LICENSE.txt'], source: 'https://github.com/madler/zlib/releases/tag/v1.3.2' },
  {
    name: 'libxml2',
    version: '2.15.3',
    versionOf: 'libxml2.dll',
    license: 'MIT',
    files: /^libxml2\.(dll|lib)$/i,
    texts: ['libxml2-Copyright.txt'],
    source: 'https://gitlab.gnome.org/GNOME/libxml2/-/tags/v2.15.3',
  },
  { name: 'libxslt', version: '1.1.45', license: 'MIT', files: /^libxslt\.dll$/i, texts: ['libxslt-Copyright.txt'], source: 'https://gitlab.gnome.org/GNOME/libxslt/-/tags/v1.1.45' },
  { name: 'LZ4', version: '1.10.0', versionOf: 'liblz4.dll', license: 'BSD-2-Clause', files: /^liblz4\.dll$/i, texts: ['lz4-LICENSE.txt'], source: 'https://github.com/lz4/lz4/releases/tag/v1.10.0' },
  {
    name: 'Zstandard',
    version: '1.5.7',
    versionOf: 'libzstd.dll',
    license: 'BSD-3-Clause',
    files: /^libzstd\.dll$/i,
    texts: ['zstd-LICENSE.txt'],
    source: 'https://github.com/facebook/zstd/releases/tag/v1.5.7',
    note: 'BSD-3-Clause와 GPL-2.0의 이중 라이선스 — BSD-3-Clause로 받는다',
  },
  { name: 'curl (libcurl)', version: '8.20.0', versionOf: 'libcurl.dll', license: 'curl', files: /^libcurl\.dll$/i, texts: ['curl-COPYING.txt'], source: 'https://curl.se/download/curl-8.20.0.tar.xz' },
  {
    name: 'mingw-w64 winpthreads',
    version: '(판 표시 없음 — 파일 판 1.0.0.0)',
    license: 'MIT (일부 BSD-3-Clause 계열)',
    files: /^libwinpthread-1\.dll$/i,
    texts: ['winpthreads-COPYING.txt'],
    source: 'https://sourceforge.net/projects/mingw-w64/',
  },
  {
    name: 'GNU libiconv',
    version: '1.15',
    versionOf: 'libiconv-2.dll',
    license: 'LGPL-2.0-or-later',
    files: /^libiconv-2\.dll$|^iconv\.lib$/i,
    texts: ['lgpl-2.0.txt'],
    source: 'https://ftp.gnu.org/pub/gnu/libiconv/libiconv-1.15.tar.gz (SHA-256 ccf536620a45458d26ba83887a983b96827001e92a13847b45e4925cc8913178)',
  },
  {
    name: 'GNU gettext — libintl',
    version: '0.19.8',
    versionOf: 'libintl-9.dll',
    license: 'LGPL-2.1-or-later',
    files: /^libintl-9\.dll$/i,
    texts: ['lgpl-2.1.txt'],
    source: 'https://ftp.gnu.org/pub/gnu/gettext/gettext-0.19.8.tar.gz (SHA-256 3da4f6bd79685648ecf46dab51d66fcdddc156f41ed07e580a696a38ac61d48f) — 라이브러리는 gettext-runtime/intl',
  },
  {
    name: 'wxWidgets',
    version: '3.2.10',
    versionOf: 'wxbase3210u_vc_x64_custom.dll',
    license: 'wxWindows Library Licence 3.1 (LGPL-2.0-or-later + 바이너리 예외)',
    files: /^wx(base|msw)3210u_\w+\.dll$/i,
    texts: ['wxwidgets-licence.txt', 'lgpl-2.0.txt'],
    source: 'https://github.com/wxWidgets/wxWidgets/releases/tag/v3.2.10',
  },
  {
    name: 'PL/pgSQL debugger (pldebugger)',
    version: '(판 표시 없음)',
    license: 'Artistic-2.0 — Copyright (c) 2004-2024 EnterpriseDB Corporation',
    files: /^plugin_debugger\.dll$/i,
    texts: ['artistic-2.0.txt'],
    source: 'https://github.com/EnterpriseDB/pldebugger',
    note: 'pgsql\\share\\extension의 pldbgapi* 포함',
  },
  {
    name: 'system_stats',
    version: '(판 표시 없음)',
    license: 'PostgreSQL License 계열 (EnterpriseDB)',
    files: /^system_stats\.dll$/i,
    texts: ['system_stats-LICENSE.txt'],
    source: 'https://github.com/EnterpriseDB/system_stats',
  },
];

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 실패 (종료 코드 ${r.status})`);
}

/** `.cmd`의 내용은 ASCII만 쓴다(명령 창은 시스템 코드 페이지로 읽는다). 줄 끝은 CRLF */
const cmdFile = (lines: string[]): string => lines.join('\r\n') + '\r\n';
/** 메모장이 읽는 글 파일 — UTF-8 BOM과 CRLF */
const textFile = (s: string): string => '\ufeff' + s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

function readme(folderMax: number): string {
  return `workfluence 체험 묶음 (Windows)

1. 이 폴더를 짧은 영문 경로에 둔다 — 예: C:\\wf. 다운로드 폴더 안에 그대로 풀지 않는다.
   이 폴더의 경로가 ${folderMax}자를 넘으면 압축을 풀 때 파일이 빠지고, 영문이 아닌 글자가 있으면 데이터베이스가 뜨지 않을 수 있다.
2. 시작.cmd 를 두 번 누른다.
   - 처음에는 데이터베이스를 만드느라 1~2분 걸린다.
   - "위키가 떴다"가 나오면 브라우저가 열린다(http://127.0.0.1:3000 — 자리 번호를 바꿨으면 그 수).
   - 처음 로그인: 아이디 root, 비밀번호는 그 창에 보인다. 첫 로그인에서 새 비밀번호로 바꾼다.
     잊었으면 data\\settings.env 의 WF_ROOT_PASSWORD 줄이다(첫 로그인 전까지만 쓸모 있다).
   - 떠 있을 때 다시 누르면 브라우저만 연다.
3. 멈추기: 그 창에서 Ctrl+C. 창을 그냥 닫았으면 멈추기.cmd 를 누른다.
4. 다시 쓰기: 시작.cmd 를 다시 누른다. 데이터는 data 폴더에 남는다. 멈춘 뒤에는 이 폴더를 옮겨도 된다(데이터·첨부가 함께 간다).
5. 처음부터 다시: 멈춘 뒤 data 폴더를 통째로 지운다. 모두 지우기: 멈춘 뒤 이 폴더를 통째로 지운다.

- "Windows의 PC 보호" 창이 뜨면 "추가 정보" -> "실행"을 누른다. 내려받은 파일이라 붙는 표시다
  (zip 파일의 속성에서 "차단 해제"를 켜고 풀면 뜨지 않는다).
- Windows 방화벽이 "Node.js"의 액세스를 허용할지 물으면 허용하지 않는다("취소"). 앱은 이 PC의 모든 네트워크 주소에서 접속을 받는
  상태로 뜬다 — 허용하면(또는 방화벽이 꺼져 있거나 3000번을 열어 두었으면) 같은 망의 다른 PC가 암호화 없는 http로 로그인 화면에
  닿는다. 이 PC 안의 브라우저는 허용하지 않아도 된다. 데이터베이스는 이 PC 안에서만 접속을 받는다.
- 운영 설치가 아니다 — 암호화 연결(TLS) 없이 http로 뜬다. 합성 데이터로만 써 본다. 혼자 쓰는 PC에서 쓴다
  (data 폴더는 처음 실행에서 지금 사용자와 관리자만 열 수 있게 권한을 좁힌다 — 비밀 값이 들어 있다).
- 3000번(앱)이나 5439번(데이터베이스) 자리를 다른 프로그램이 쓰면 시작.cmd가 까닭을 말하고 멈춘다 —
  data\\settings.env 의 WF_PORT(앱)나 WF_PG_EMBEDDED_PORT(데이터베이스)를 다른 수로 바꿔 저장하고 다시 누른다.

들어 있는 것: node\\ (Node.js — MIT, node\\LICENSE), pgsql\\ (PostgreSQL 17과 그것이 쓰는 라이브러리, Microsoft Visual C++ 재배포 가능
런타임 DLL — 구성 요소마다의 라이선스는 pgsql\\THIRD_PARTY_NOTICES.txt), app\\ (workfluence와 그것이 쓰는 npm 패키지 — 패키지마다의 LICENSE).
`;
}

/** 파일마다의 판 정보(ProductVersion) — PowerShell로 한 번에 읽는다(파일 이름·판은 ASCII) */
function productVersions(dir: string): Map<string, string> {
  const script = `Get-ChildItem -LiteralPath $env:TRIAL_DIR -File | ForEach-Object { '{0}|{1}' -f $_.Name, $_.VersionInfo.ProductVersion }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    env: { ...process.env, TRIAL_DIR: dir },
  });
  if (r.status !== 0) throw new Error(`판 정보를 읽지 못했다: ${r.stderr}`);
  const m = new Map<string, string>();
  for (const line of r.stdout.split(/\r?\n/)) {
    const i = line.indexOf('|');
    if (i > 0) m.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim().replace(/,\s*/g, '.'));
  }
  return m;
}

/**
 * `pgsql/`의 고지 — 모든 파일이 어느 구성 요소인지 가리고, 판이 적은 것과 같은지 보고, `COPYRIGHT`와 `THIRD_PARTY_NOTICES.txt`를 쓴다.
 * 하나라도 어긋나면 멈춘다
 */
function writePgNotices(pgDir: string, wrapperLicense: string, vcRuntime: string[]): void {
  const bin = join(pgDir, 'bin');
  const lib = join(pgDir, 'lib');
  const owner = new Map<Component, string[]>();
  const unknown: string[] = [];
  const add = (c: Component, f: string): void => {
    owner.set(c, [...(owner.get(c) ?? []), f]);
  };
  const postgres = PG_COMPONENTS[0];
  for (const f of readdirSync(bin)) {
    if (vcRuntime.includes(f.toLowerCase())) continue;
    const c = PG_COMPONENTS.find((x) => x.files?.test(f));
    if (c) add(c, `pgsql\\bin\\${f}`);
    else unknown.push(`pgsql\\bin\\${f}`);
  }
  for (const f of readdirSync(lib)) {
    const c = PG_COMPONENTS.find((x) => x.files?.test(f));
    if (c) add(c, `pgsql\\lib\\${f}`);
    else if (/\.dll$/i.test(f)) add(postgres, `pgsql\\lib\\${f}`);
    else unknown.push(`pgsql\\lib\\${f}`);
  }
  if (unknown.length) throw new Error(`고지에 없는 파일이 묶음에 들어간다 — scripts/win-bundle.ts의 PG_COMPONENTS에 더하고 원문을 scripts/win-notices/에 둔다: ${unknown.join(', ')}`);
  const versions = productVersions(bin);
  const wrong: string[] = [];
  for (const c of PG_COMPONENTS) {
    if (!owner.has(c)) wrong.push(`${c.name}: 파일이 없다(구성이 바뀌었다)`);
    if (!c.versionOf) continue;
    const v = versions.get(c.versionOf.toLowerCase()) ?? '';
    if (!v.startsWith(c.version)) wrong.push(`${c.name}: ${c.versionOf}의 판이 ${v || '(없음)'} — 고지는 ${c.version}`);
  }
  if (wrong.length) throw new Error(`고지와 묶음이 어긋난다 — 판·소스 위치·원문을 그 판으로 고친다: ${wrong.join('; ')}`);

  const text = (name: string): string => {
    const p = join(notices, name);
    if (!existsSync(p)) throw new Error(`라이선스 원문이 없다: ${p}`);
    return readFileSync(p, 'utf8');
  };
  const pgCopyright = text('postgresql-COPYRIGHT.txt');
  writeFileSync(join(pgDir, 'COPYRIGHT'), textFile(pgCopyright));

  const lines: string[] = [
    'workfluence 체험 묶음 — pgsql\\ 에 함께 들어 있는 구성 요소와 라이선스',
    '(scripts/win-bundle.ts가 묶을 때 만든다. 원문은 저장소의 scripts/win-notices/)',
    '',
    '다른 자리: node\\LICENSE (Node.js와 그 안에 든 구성 요소), app\\api\\node_modules\\ 의 패키지마다의 LICENSE',
    '',
    '== 구성 요소 ==',
  ];
  for (const c of PG_COMPONENTS) {
    lines.push('', `${c.name} ${c.version} — ${c.license}`, `  파일: ${(owner.get(c) ?? []).join(', ')}`, `  소스: ${c.source}`);
    if (c.note) lines.push(`  참고: ${c.note}`);
    lines.push(`  원문: ${c.texts.join(', ')}`);
  }
  lines.push(
    '',
    `embedded-postgres (PostgreSQL을 npm 패키지로 묶은 것 — @embedded-postgres/windows-x64) — MIT`,
    '  원문: 아래 embedded-postgres LICENSE',
    '',
    `Microsoft Visual C++ 재배포 가능 런타임 — Microsoft 소프트웨어 사용 조건(Visual Studio의 재배포 가능 코드)`,
    `  파일: ${vcRuntime.map((d) => `pgsql\\bin\\${d}`).join(', ')}`,
    '',
    '== LGPL 구성 요소 ==',
    '',
    'GNU libiconv(pgsql\\bin\\libiconv-2.dll)와 GNU gettext의 libintl(pgsql\\bin\\libintl-9.dll)은 LGPL이다. PostgreSQL 실행 파일은',
    '이 DLL을 동적으로 연결해 쓴다 — 같은 이름의 호환되는 빌드로 바꿔 넣어 쓸 수 있다. 수정해 쓰는 것과 그것을 위한 역공학을 막지 않는다.',
    '소스는 위 "소스"의 주소(판을 맞춘 upstream 소스와 SHA-256)에서 받는다. wxWidgets는 wxWindows Library Licence의 예외에 따라 바이너리를 배포한다.',
  );
  const seen = new Set<string>();
  const section = (title: string, body: string): void => {
    lines.push('', '='.repeat(78), title, '='.repeat(78), '', body.trimEnd());
  };
  for (const c of PG_COMPONENTS)
    for (const t of c.texts)
      if (!seen.has(t)) {
        seen.add(t);
        section(`원문: ${t}`, text(t));
      }
  section('원문: embedded-postgres LICENSE', wrapperLicense);
  writeFileSync(join(pgDir, 'THIRD_PARTY_NOTICES.txt'), textFile(lines.join('\n') + '\n'));
}

/** 묶음 안의 상대 경로(파일)를 긴 것부터 `n`개 */
function longestPaths(dir: string, n: number): string[] {
  const all: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (lstatSync(p).isDirectory()) walk(p);
      else all.push(relative(dir, p));
    }
  };
  walk(dir);
  return all.sort((a, b) => b.length - a.length).slice(0, n);
}

/**
 * 패키지가 잘못 싣고 나온 시험 도구의 캐시(`…/node_modules/.vite`)를 뺀다 — 실행에 쓰이지 않고 묶음에서 가장 긴 경로였다
 * (`@nestjs/serve-static@12.0.0`의 `tests/node_modules/.vite/vitest/<해시>/results.json`, 207자 — 2026-09-29 러너). 뺀 폴더 수를 돌려준다
 */
function pruneToolCaches(dir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (!st.isDirectory()) continue;
      if (name === '.vite' && basename(d) === 'node_modules') {
        rmSync(p, { recursive: true, force: true });
        n++;
      } else walk(p);
    }
  };
  walk(dir);
  return n;
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows에서만 만든다 — 묶음의 네이티브 파일(argon2·PostgreSQL·node.exe)이 이 컴퓨터의 것이어야 한다');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'app'), { recursive: true });

  // 1) api — 운영 이미지와 같은 모양(production 의존성만, 이 컴퓨터용 네이티브)
  run('pnpm', ['--filter', '@workfluence/api', 'deploy', '--legacy', '--prod', JSON.stringify(join(out, 'app', 'api'))]);
  // 1-1) 연결을 목록으로 — 모두 묶음 안을 가리켜야 한다
  const apiDir = join(out, 'app', 'api');
  const links: { path: string; target: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(p), readlinkSync(p));
        if (!target.startsWith(apiDir + sep)) throw new Error(`묶음 밖을 가리키는 연결: ${p} -> ${target}`);
        links.push({ path: relative(apiDir, p), target: relative(apiDir, target) });
      } else if (st.isDirectory()) walk(p);
    }
  };
  const pruned = pruneToolCaches(join(apiDir, 'node_modules'));
  walk(join(apiDir, 'node_modules'));
  for (const l of links) {
    const p = join(apiDir, l.path);
    try {
      unlinkSync(p);
    } catch {
      rmdirSync(p);
    }
  }
  writeFileSync(join(out, 'app', 'links.json'), JSON.stringify(links));
  // 2) 화면 — api가 `WF_WEB_DIST=../web/dist`로 찾는다
  cpSync(join(root, 'apps', 'web', 'dist'), join(out, 'app', 'web', 'dist'), { recursive: true });
  // 3) 여는 스크립트와 설정의 본
  cpSync(join(root, 'scripts', 'win-launcher.mjs'), join(out, 'app', 'launcher.mjs'));
  cpSync(join(root, '.env.example'), join(out, 'app', 'env.example'));
  // 4) Node — 이 스크립트를 돌리는 것. 라이선스 없이 내보내지 않는다
  mkdirSync(join(out, 'node'));
  cpSync(process.execPath, join(out, 'node', 'node.exe'));
  const nodeLicense = join(dirname(process.execPath), 'LICENSE');
  if (!existsSync(nodeLicense)) throw new Error(`Node.js의 LICENSE가 없다: ${nodeLicense} — node.exe를 라이선스 없이 묶지 않는다`);
  cpSync(nodeLicense, join(out, 'node', 'LICENSE'));
  // 5) PostgreSQL — 개발 DB 스크립트(`scripts/dev-db.ts`)와 같은 길로 찾는다
  const fromEmbedded = createRequire(createRequire(__filename).resolve('embedded-postgres'));
  const pgEntry = fromEmbedded.resolve('@embedded-postgres/windows-x64');
  const { pg_ctl: pgCtl } = (await import(pathToFileURL(pgEntry).href)) as { pg_ctl: string };
  cpSync(dirname(dirname(pgCtl)), join(out, 'pgsql'), { recursive: true });
  let pkgDir = dirname(pgEntry);
  while (!existsSync(join(pkgDir, 'package.json')) && dirname(pkgDir) !== pkgDir) pkgDir = dirname(pkgDir);
  const wrapperLicense = readdirSync(pkgDir).find((f) => /^license/i.test(f));
  if (!wrapperLicense) throw new Error(`embedded-postgres 패키지의 LICENSE가 없다: ${pkgDir}`);
  // 6) VC++ 런타임
  const sys32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const copied = VC_RUNTIME.filter((d) => existsSync(join(sys32, d)));
  if (!copied.includes('vcruntime140.dll') || !copied.includes('msvcp140.dll')) throw new Error(`VC++ 런타임이 이 컴퓨터에 없다: ${sys32}`);
  for (const d of copied) cpSync(join(sys32, d), join(out, 'pgsql', 'bin', d));
  // 6-1) 고지 — 모든 파일의 구성 요소·판을 확인하고 COPYRIGHT·THIRD_PARTY_NOTICES.txt를 쓴다
  writePgNotices(join(out, 'pgsql'), readFileSync(join(pkgDir, wrapperLicense), 'utf8'), copied);
  // 7) 경로 길이 — 탐색기는 260자를 넘는 경로를 풀지 못한다
  const top = longestPaths(out, 5);
  const longest = top[0]?.length ?? 0;
  console.log(`[win-bundle] 긴 경로(뺀 시험 캐시 ${pruned}개):\n${top.map((p) => `  ${p.length} ${p}`).join('\n')}`);
  if (longest > LONGEST_PATH_LIMIT) throw new Error(`묶음 안의 경로가 너무 길다(${longest}자 > ${LONGEST_PATH_LIMIT}): ${top[0]}`);
  const folderMax = MAX_PATH - 1 - longest;
  writeFileSync(join(out, 'app', 'bundle.json'), JSON.stringify({ longestPath: longest }));
  // 8) 여는 명령과 읽어보기. 실패하면 창이 닫히지 않게 멈춘다(자동 확인은 TRIAL_NO_PAUSE=1)
  writeFileSync(
    join(out, '시작.cmd'),
    cmdFile(['@echo off', 'setlocal', '"%~dp0node\\node.exe" "%~dp0app\\launcher.mjs" start %*', 'if errorlevel 1 if not "%TRIAL_NO_PAUSE%"=="1" pause']),
  );
  writeFileSync(
    join(out, '멈추기.cmd'),
    cmdFile(['@echo off', 'setlocal', '"%~dp0node\\node.exe" "%~dp0app\\launcher.mjs" stop %*', 'if not "%TRIAL_NO_PAUSE%"=="1" pause']),
  );
  writeFileSync(join(out, '읽어보기.txt'), textFile(readme(folderMax)));
  console.log(`[win-bundle] ${out} — 연결 ${links.length}개, VC++ 런타임 ${copied.join(', ')}`);
  console.log(`[win-bundle] 가장 긴 경로 ${longest}자 — 풀 자리의 경로는 ${folderMax}자까지`);
}

main().catch((e: unknown) => {
  console.error(`[win-bundle] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
