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
 *
 * **어떤 실행 파일도 쓰지 않는 구성 요소는 넣지 않는다**(사용자 결정 2026-09-29 — 체험 가이드 10.3절). embedded-postgres가 싣고 나온 EDB 배포판에는 다른
 * 도구(pgAdmin·StackBuilder·ecpg 등)의 라이브러리와 EDB의 확장이 함께 있다 — 아래 `PG_DROPPED`가 그것을 빼고, 남은 파일의 가져오기 목록(PE import)을
 * 읽어 뺀 파일을 가져오는 것이 없는지 본다(`checkImports`). 뺀 목록은 묶음 밖의 `.local/win-bundle/dropped-files.json`에 적는다 — 워크플로가 받은 묶음에
 * 그 파일이 없는지 본다
 *
 * **LGPL 구성 요소(GNU libiconv·libintl)의 소스는 같은 실행의 별도 결과물이다**(사용자 결정 2026-09-29 (가′) — 체험 가이드 10.3절). 묶음 밖의
 * `.local/win-bundle/lgpl-sources.json`에 받을 tarball(주소·SHA-256)을 적고 `.local/win-bundle/lgpl-sources/`에 읽어보기를 둔다 — 워크플로가 tarball을
 * 받아 SHA-256을 맞추고 그 폴더를 결과물 `LGPL_SOURCES_ARTIFACT`로 올린다. 판·주소·SHA-256은 아래 `PG_COMPONENTS` 한 곳이다
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
  files: RegExp;
  /** `scripts/win-notices/`의 원문 */
  texts: string[];
  source: string;
  /** LGPL 구성 요소 — 판을 맞춘 upstream 소스 tarball. 워크플로가 받아 SHA-256을 맞추고 묶음과 같은 실행의 결과물로 올린다 */
  sourceArchive?: SourceArchive;
  note?: string;
};

type SourceArchive = { url: string; sha256: string };

/** LGPL 소스를 올리는 결과물의 이름 — 워크플로(`.github/workflows/windows-local.yml`)의 올리기·지우기와 같다. 러너가 고지에 이 이름이 있는지 본다 */
const LGPL_SOURCES_ARTIFACT = 'workfluence-windows-trial-lgpl-sources';

const ICONV_SOURCE: SourceArchive = {
  url: 'https://ftp.gnu.org/pub/gnu/libiconv/libiconv-1.15.tar.gz',
  sha256: 'ccf536620a45458d26ba83887a983b96827001e92a13847b45e4925cc8913178',
};
const GETTEXT_SOURCE: SourceArchive = {
  url: 'https://ftp.gnu.org/pub/gnu/gettext/gettext-0.19.8.tar.gz',
  sha256: '3da4f6bd79685648ecf46dab51d66fcdddc156f41ed07e580a696a38ac61d48f',
};
const sourceText = (a: SourceArchive): string => `${a.url} (SHA-256 ${a.sha256})`;

/**
 * `pgsql/`에 든 것 — `@embedded-postgres/windows-x64@17.10.0-beta.17`을 열어 가져오기 목록(PE import)과 판 정보로 확인했다(2026-09-29).
 * PostgreSQL 실행 파일(postgres·initdb·pg_ctl)은 libintl-9.dll을 **직접 가져온다** — 그 DLL(과 그것이 가져오는 libiconv-2·libwinpthread-1)이
 * 없으면 Windows가 실행 파일을 띄우지 않는다. 라이선스의 판정은 체험 가이드 10.3절 — PostgreSQL License·Zlib·ICU License는 허용적 라이선스로 본다
 * (사용자 결정 2026-09-29), LGPL 둘(libiconv·libintl)은 승인했고 소스를 같은 실행의 별도 결과물로 내준다(사용자 결정 2026-09-29 (가′))
 */
const PG_COMPONENTS: Component[] = [
  {
    name: 'PostgreSQL',
    version: '17.10',
    versionOf: 'postgres.exe',
    license: 'PostgreSQL License',
    files: /^(postgres|initdb|pg_ctl)\.exe$|^libpq\.dll$/i,
    texts: ['postgresql-COPYRIGHT.txt'],
    source: 'https://ftp.postgresql.org/pub/source/v17.10/postgresql-17.10.tar.bz2',
    note: 'pgsql\\lib의 확장 모듈(.dll)과 pgsql\\share 포함. Windows 빌드는 EDB의 배포판을 embedded-postgres가 다시 묶은 것이다',
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
    files: /^icu(dt|in|uc)67\.dll$/i,
    texts: ['icu-LICENSE.txt'],
    source: 'https://github.com/unicode-org/icu/releases/tag/release-67-1',
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
    source: sourceText(ICONV_SOURCE),
    sourceArchive: ICONV_SOURCE,
  },
  {
    name: 'GNU gettext — libintl',
    version: '0.19.8',
    versionOf: 'libintl-9.dll',
    license: 'LGPL-2.1-or-later',
    files: /^libintl-9\.dll$/i,
    texts: ['lgpl-2.1.txt'],
    source: `${sourceText(GETTEXT_SOURCE)} — 라이브러리는 gettext-runtime/intl`,
    sourceArchive: GETTEXT_SOURCE,
  },
];

/**
 * 묶음에서 빼는 것 — **어떤 실행 파일(postgres·initdb·pg_ctl)도 가져오지 않는 구성 요소**(사용자 결정 2026-09-29 "2·3·4번 추천대로" — 체험 가이드 10.3절).
 * 같은 패키지를 열어 가져오기 목록으로 확인했다(2026-09-29): 아래 DLL을 가져오는 것은 서로(wxWidgets끼리·ecpg끼리)와 `pgxml.dll`뿐이다 — 그래서
 * libxslt를 빼면 불러올 수 없는 xml2 확장(`pgxml.dll`·`xml2*`)도 뺀다(앱이 쓰는 확장은 pg_trgm뿐이다). 뺀 뒤에 남은 파일이 뺀 파일을 가져오면 묶기가
 * 멈춘다(`checkImports`). 한 줄이라도 아무 파일에 맞지 않으면 멈춘다 — 패키지의 구성이 바뀌었다(이 목록과 고지를 다시 본다)
 */
const PG_DROPPED: { what: string; bin?: RegExp; lib?: RegExp; share?: RegExp }[] = [
  { what: 'wxWidgets 3.2.10 — pgAdmin·StackBuilder의 화면 라이브러리', bin: /^wx(base|msw)3210u_\w+\.dll$/i },
  { what: 'curl — libcurl 8.20.0', bin: /^libcurl\.dll$/i },
  { what: 'ICU의 io·tu 라이브러리와 시험용 플러그인(testplug)', bin: /^icu(io|tu)67\.dll$|^testplug\.dll$/i },
  { what: 'PostgreSQL ecpg(내장 SQL 전처리기)의 라이브러리', bin: /^lib(ecpg|ecpg_compat|pgtypes)\.dll$/i },
  { what: 'libxslt 1.1.45', bin: /^libxslt\.dll$/i },
  { what: 'PostgreSQL xml2 확장 — libxslt 없이는 불러올 수 없다', lib: /^pgxml\.dll$/i, share: /^xml2(--.*\.sql|\.control)$/i },
  { what: 'PL/pgSQL debugger (pldebugger)', lib: /^plugin_debugger\.dll$/i, share: /^pldbgapi(--.*\.sql|\.control)$/i },
  { what: 'system_stats (EnterpriseDB)', lib: /^system_stats\.dll$/i, share: /^system_stats(--.*\.sql|\.control)$/i },
];

/**
 * PE 파일(.exe·.dll)이 가져오는 DLL의 이름(소문자) — 가져오기 표와 지연 가져오기 표. PE가 아니면 null. 표를 읽지 못하면 멈춘다(판정하지 않고 넘어가지 않는다)
 */
function peImports(file: string): string[] | null {
  const b = readFileSync(file);
  if (b.length < 0x40 || b.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = b.readUInt32LE(0x3c);
  if (pe + 24 > b.length || b.readUInt32LE(pe) !== 0x4550) return null;
  const sections = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const pe32plus = b.readUInt16LE(opt) === 0x20b;
  const imageBase = pe32plus ? Number(b.readBigUInt64LE(opt + 24)) : b.readUInt32LE(opt + 28);
  const dirCount = b.readUInt32LE(opt + (pe32plus ? 108 : 92));
  const dirs = opt + (pe32plus ? 112 : 96);
  const secs = Array.from({ length: sections }, (_, i) => {
    const s = opt + optSize + i * 40;
    return { va: b.readUInt32LE(s + 12), size: Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16)), raw: b.readUInt32LE(s + 20) };
  });
  const at = (rva: number): number => {
    const s = secs.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new Error(`가져오기 표를 읽지 못했다: ${file} (RVA ${rva})`);
    return rva - s.va + s.raw;
  };
  const text = (rva: number): string => {
    const o = at(rva);
    return b.toString('latin1', o, b.indexOf(0, o)).toLowerCase();
  };
  const out: string[] = [];
  // 가져오기 표(디렉터리 1): 항목 20바이트, 이름은 12바이트째. 지연 가져오기(13): 항목 32바이트, 속성 0바이트째·이름 4바이트째(속성 1이 아니면 RVA가 아닌 VA)
  if (dirCount > 1 && b.readUInt32LE(dirs + 8))
    for (let o = at(b.readUInt32LE(dirs + 8)); b.readUInt32LE(o + 12); o += 20) out.push(text(b.readUInt32LE(o + 12)));
  if (dirCount > 13 && b.readUInt32LE(dirs + 13 * 8))
    for (let o = at(b.readUInt32LE(dirs + 13 * 8)); b.readUInt32LE(o + 4); o += 32) {
      const name = b.readUInt32LE(o + 4);
      out.push(text(b.readUInt32LE(o) & 1 ? name : name - imageBase));
    }
  return out;
}

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

1. 이 폴더를 짧은 영문 경로에 둔다. 다운로드 폴더 안에 그대로 풀지 않는다.
   이 폴더의 경로가 ${folderMax}자를 넘으면 압축을 풀 때 파일이 빠지고, 영문이 아닌 글자가 있으면 데이터베이스가 뜨지 않을 수 있다.
   - 권하는 자리: 내 사용자 폴더 아래 — 예: C:\\Users\\<이름>\\wf. 이 PC의 다른 계정이 이 폴더의 파일을 고칠 수 없다.
     다만 사용자 이름에 영문이 아닌 글자(한글 등)가 있으면 그 자리는 쓰지 않는다 — 위의 까닭으로 데이터베이스가 뜨지 않을 수 있다.
   - 그럴 때는 C:\\wf 같은 자리. C:\\ 바로 아래에 만든 폴더는 이 PC의 다른 계정도 고칠 수 있다 — 누가 실행 파일(node\\node.exe 등)을
     바꾸거나 pgsql\\bin 에 DLL을 더해 두면 다음에 시작.cmd 를 누를 때 그것이 내 권한으로 돈다. 다른 사람이 로그인하지 않는 PC에서만 쓴다(시작할 때 창도 알린다).
2. 시작.cmd 를 두 번 누른다.
   - 처음에는 데이터베이스를 만드느라 1~2분 걸린다.
   - "위키가 떴다"가 나오면 브라우저가 열린다(http://127.0.0.1:3000 — 자리 번호를 바꿨으면 그 수).
   - 처음 로그인: 아이디 root, 비밀번호는 그 창에 보인다. 첫 로그인에서 새 비밀번호로 바꾼다.
     잊었으면 data\\settings.env 의 WF_ROOT_PASSWORD 줄이다(첫 로그인 전까지만 쓸모 있다).
   - 떠 있을 때 다시 누르면 브라우저만 연다.
3. 멈추기: 그 창에서 Ctrl+C. 창을 그냥 닫았으면 멈추기.cmd 를 누른다.
4. 다시 쓰기: 시작.cmd 를 다시 누른다. 데이터는 data 폴더에 남는다. 멈춘 뒤에는 이 폴더를 옮겨도 된다(데이터·첨부가 함께 간다).
5. 처음부터 다시: 멈춘 뒤 data 폴더를 통째로 지운다. 모두 지우기: 멈춘 뒤 이 폴더를 통째로 지운다.
   처음 실행이 중간에 끊겼으면 시작.cmd 를 다시 누른다 — 끝까지 만들지 못한 데이터베이스는 지우지 않고 data\\pgdata.broken-<시각> 으로
   옮겨 두고 새로 만든다(쓸 것이 없으면 그 폴더는 지워도 된다).
6. 새 묶음으로 옮기기: 두 묶음을 모두 멈추고, 옛 묶음의 data 폴더를 새 묶음의 폴더에 복사한 뒤 새 묶음의 시작.cmd 를 누른다.
   새 묶음이 모르는 설정 줄이 settings.env 에 있으면 창이 그 이름을 알리고 앱에 넘기지 않는다.

- "Windows의 PC 보호" 창이 뜨면 "추가 정보" -> "실행"을 누른다. 내려받은 파일이라 붙는 표시다
  (zip 파일의 속성에서 "차단 해제"를 켜고 풀면 뜨지 않는다).
- Windows 방화벽이 "Node.js"의 액세스를 허용할지 물으면 허용하지 않는다("취소"). 앱은 이 PC의 모든 네트워크 주소에서 접속을 받는
  상태로 뜬다 — 허용하면(또는 방화벽이 꺼져 있거나 3000번을 열어 두었으면) 같은 망의 다른 PC가 암호화 없는 http로 로그인 화면에
  닿는다. 이 PC 안의 브라우저는 허용하지 않아도 된다. 데이터베이스는 이 PC 안에서만 접속을 받는다.
- 운영 설치가 아니다 — 암호화 연결(TLS) 없이 http로 뜬다. 합성 데이터로만 써 본다. 혼자 쓰는 PC에서 쓴다
  (data 폴더는 시작할 때마다 지금 사용자와 관리자만 열 수 있게 권한을 좁힌다 — 비밀 값이 들어 있다. 이 폴더의 나머지는 좁히지 않는다 — 1번).
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
    const c = PG_COMPONENTS.find((x) => x.files.test(f));
    if (c) add(c, `pgsql\\bin\\${f}`);
    else unknown.push(`pgsql\\bin\\${f}`);
  }
  for (const f of readdirSync(lib)) {
    const c = PG_COMPONENTS.find((x) => x.files.test(f));
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
    `소스: 이 묶음을 받은 곳(GitHub Actions의 같은 실행)의 결과물 ${LGPL_SOURCES_ARTIFACT}에 판을 맞춘 upstream 소스 tarball이`,
    '함께 올라가 있다 — 묶음과 같은 기간 보관된다. 위 "소스"의 주소에서도 받을 수 있고, SHA-256으로 같은 파일인지 확인한다.',
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

/**
 * LGPL 구성 요소의 소스 (사용자 결정 2026-09-29 (가′)) — `lgpl-sources.json`(워크플로가 받을 주소·SHA-256·파일 이름)과 `lgpl-sources/README.txt`.
 * tarball은 여기서 받지 않는다 — 묶음(zip)에 넣지 않고 같은 실행의 별도 결과물로 올린다
 */
function writeLgplSources(base: string): void {
  const list = PG_COMPONENTS.filter((c) => c.sourceArchive).map((c) => {
    const a = c.sourceArchive!;
    return { name: c.name, version: c.version, license: c.license, url: a.url, sha256: a.sha256, file: basename(new URL(a.url).pathname) };
  });
  const dir = join(base, 'lgpl-sources');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(base, 'lgpl-sources.json'), JSON.stringify(list, null, 1));
  const lines = [
    'workfluence 체험 묶음 — LGPL 구성 요소의 소스',
    '',
    `같은 실행의 묶음(workfluence-windows-trial)의 pgsql\\bin 에 든 아래 라이브러리의 소스다. 판을 맞춘 upstream 소스 tarball을 받아`,
    'SHA-256을 맞춘 것이다. 라이선스 원문과 구성 요소 목록은 묶음의 pgsql\\THIRD_PARTY_NOTICES.txt 에 있다.',
    '',
    ...list.flatMap((s) => [`${s.name} ${s.version} — ${s.license}`, `  파일: ${s.file}`, `  받은 곳: ${s.url}`, `  SHA-256: ${s.sha256}`, '']),
  ];
  writeFileSync(join(dir, 'README.txt'), textFile(lines.join('\n')));
}

/**
 * `PG_DROPPED`의 파일을 `pgsql/`에서 지우고 지운 것을 돌려준다 — `pgsql/` 안의 상대 경로(`\\` 구분). 아무 파일에도 맞지 않는 줄이 있으면 멈춘다
 */
function dropUnused(pgDir: string): string[] {
  const dropped: string[] = [];
  const idle: string[] = [];
  for (const d of PG_DROPPED) {
    let n = 0;
    for (const [sub, re] of [
      [['bin'], d.bin],
      [['lib'], d.lib],
      [['share', 'extension'], d.share],
    ] as const) {
      const dir = join(pgDir, ...sub);
      if (!re || !existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => re.test(x))) {
        rmSync(join(dir, f));
        dropped.push(['pgsql', ...sub, f].join('\\'));
        n++;
      }
    }
    if (!n) idle.push(d.what);
  }
  if (idle.length) throw new Error(`뺄 파일이 없다(패키지의 구성이 바뀌었다) — scripts/win-bundle.ts의 PG_DROPPED와 고지를 다시 본다: ${idle.join('; ')}`);
  return dropped;
}

/**
 * 남은 PostgreSQL 파일(`pgsql/bin`·`pgsql/lib`의 .exe·.dll)이 뺀 파일을 가져오지 않는지 본다 — 가져오면 그 파일은 Windows가 불러오지 못한다.
 * 실행 파일 셋은 가져오기 목록이 있어야 한다(읽는 길이 맞는지의 확인)
 */
function checkImports(pgDir: string, dropped: string[]): void {
  const gone = new Set(dropped.map((p) => (p.split('\\').pop() ?? '').toLowerCase()));
  const broken: string[] = [];
  for (const sub of ['bin', 'lib'])
    for (const f of readdirSync(join(pgDir, sub)).filter((x) => /\.(exe|dll)$/i.test(x))) {
      const imports = peImports(join(pgDir, sub, f));
      if (imports === null) throw new Error(`PE 파일이 아니다: pgsql\\${sub}\\${f}`);
      if (/^(postgres|initdb|pg_ctl)\.exe$/i.test(f) && !imports.includes('libintl-9.dll')) throw new Error(`가져오기 목록을 제대로 읽지 못했다: pgsql\\${sub}\\${f} → ${imports.join(', ')}`);
      const bad = imports.filter((d) => gone.has(d));
      if (bad.length) broken.push(`pgsql\\${sub}\\${f} → ${bad.join(', ')}`);
    }
  if (broken.length) throw new Error(`남은 파일이 뺀 파일을 가져온다 — 그 파일도 PG_DROPPED에 넣거나 빼지 않는다: ${broken.join('; ')}`);
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
  // 6-1) 어떤 실행 파일도 쓰지 않는 구성 요소를 빼고, 남은 파일이 그것을 가져오지 않는지 본다. 뺀 목록은 묶음 밖에 적는다(워크플로가 받은 묶음에 없는지 본다)
  const dropped = dropUnused(join(out, 'pgsql'));
  checkImports(join(out, 'pgsql'), dropped);
  writeFileSync(join(dirname(out), 'dropped-files.json'), JSON.stringify(dropped, null, 1));
  console.log(`[win-bundle] 어떤 실행 파일도 쓰지 않는 파일 ${dropped.length}개를 뺐다 — 남은 파일은 그것을 가져오지 않는다:\n${dropped.map((f) => `  ${f}`).join('\n')}`);
  // 6-2) 고지 — 모든 파일의 구성 요소·판을 확인하고 COPYRIGHT·THIRD_PARTY_NOTICES.txt를 쓴다
  writePgNotices(join(out, 'pgsql'), readFileSync(join(pkgDir, wrapperLicense), 'utf8'), copied);
  // 6-3) LGPL 소스 — 받을 tarball의 목록과 읽어보기를 묶음 밖에 둔다. 받아서 SHA-256을 맞추고 올리는 것은 워크플로다
  writeLgplSources(dirname(out));
  // 7) 경로 길이 — 탐색기는 260자를 넘는 경로를 풀지 못한다
  const top = longestPaths(out, 5);
  const longest = top[0]?.length ?? 0;
  console.log(`[win-bundle] 긴 경로(뺀 시험 캐시 ${pruned}개):\n${top.map((p) => `  ${p.length} ${p}`).join('\n')}`);
  if (longest > LONGEST_PATH_LIMIT) throw new Error(`묶음 안의 경로가 너무 길다(${longest}자 > ${LONGEST_PATH_LIMIT}): ${top[0]}`);
  const folderMax = MAX_PATH - 1 - longest;
  writeFileSync(join(out, 'app', 'bundle.json'), JSON.stringify({ longestPath: longest }));
  // 8) 여는 명령과 읽어보기. 실패하면 창이 닫히지 않게 멈춘다(자동 확인은 TRIAL_NO_PAUSE=1). 여는 스크립트의 종료 코드를 그대로 돌려준다 —
  //    마지막 줄이 조건이 거짓인 `if`면 명령 창은 0을 돌려준다(2026-09-29 러너 — 자리가 차서 1로 끝났는데 시작.cmd는 0이었다)
  const launch = (command: string, pauseAlways: boolean): string =>
    cmdFile([
      '@echo off',
      'setlocal',
      `"%~dp0node\\node.exe" "%~dp0app\\launcher.mjs" ${command} %*`,
      'set "RC=%ERRORLEVEL%"',
      `${pauseAlways ? '' : 'if not "%RC%"=="0" '}if not "%TRIAL_NO_PAUSE%"=="1" pause`,
      'exit /b %RC%',
    ]);
  writeFileSync(join(out, '시작.cmd'), launch('start', false));
  writeFileSync(join(out, '멈추기.cmd'), launch('stop', true));
  writeFileSync(join(out, '읽어보기.txt'), textFile(readme(folderMax)));
  console.log(`[win-bundle] ${out} — 연결 ${links.length}개, VC++ 런타임 ${copied.join(', ')}`);
  console.log(`[win-bundle] 가장 긴 경로 ${longest}자 — 풀 자리의 경로는 ${folderMax}자까지`);
}

main().catch((e: unknown) => {
  console.error(`[win-bundle] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
