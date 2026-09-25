/**
 * 사내 LLM 질문의 **흐름 계약** (A등급, P10_설계서_Llm D.1·FR-1104).
 *
 * 서버(`apps/api/src/llm/`)가 한 줄씩 쓰고 화면이 한 줄씩 읽는다(NDJSON). 줄의 모양·줄 나누기·주소 판정을 여기 한 곳에
 * 둔다 — 서버와 화면이 따로 적으면 한쪽만 바뀐다(1.3절). 순수 함수이고 브라우저·Node 어느 쪽 전용 API도 쓰지 않는다.
 */

/** 흐름의 끝 — 끝남·중지·실패 (FR-1113·1120) */
export const LLM_STREAM_STATUSES = ['done', 'stopped', 'failed'] as const;
export type LlmStreamStatus = (typeof LLM_STREAM_STATUSES)[number];

/**
 * 흐름의 줄 (D.1).
 *
 * - `delta` 답의 조각 · `thinking` 생각 과정의 조각(저장하지 않는다, FR-1119) · `ping` 살아 있음(FR-1115)
 * - `end` **마지막 한 줄.** 저장했는가, 어느 대화인가, 상한 때문에 지운 대화 수, 사람이 읽을 까닭
 */
export type LlmStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'ping' }
  | {
      type: 'end';
      status: LlmStreamStatus;
      saved: boolean;
      conversationId: string | null;
      evicted: number;
      message: string | null;
    };

/** 한 줄로 적는다. JSON이 글자 속 줄바꿈을 이스케이프하므로 **줄 하나가 이벤트 하나**다 */
export function encodeLlmEvent(event: LlmStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * 흐름을 줄로 나눈다. 조각이 줄 가운데서 끊겨 와도 된다 — 네트워크는 줄 경계를 모른다.
 * 바이트를 글자로 바꾸는 일(`TextDecoder`의 `stream` 모드)은 부르는 쪽이 한다.
 */
export function createLineSplitter(): { push(chunk: string): string[]; end(): string[] } {
  let rest = '';
  const take = (lines: string[]) => lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
  return {
    push(chunk: string): string[] {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop() ?? '';
      return take(parts);
    },
    end(): string[] {
      const last = rest;
      rest = '';
      return take([last]);
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 한 줄을 읽는다. **모양이 틀리면 `null`** — 화면은 모르는 줄을 그리지 않는다.
 * 끝 줄은 모든 칸을 본다 — 화면이 이 줄로 "저장됐나"와 "어느 대화로 가나"를 정한다.
 */
export function parseLlmEvent(line: string): LlmStreamEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  switch (v.type) {
    case 'delta':
    case 'thinking':
      return typeof v.text === 'string' ? { type: v.type, text: v.text } : null;
    case 'ping':
      return { type: 'ping' };
    case 'end': {
      const { status, saved, conversationId, evicted, message } = v;
      if (!(LLM_STREAM_STATUSES as readonly unknown[]).includes(status)) return null;
      if (typeof saved !== 'boolean') return null;
      if (conversationId !== null && typeof conversationId !== 'string') return null;
      if (typeof evicted !== 'number' || !Number.isInteger(evicted) || evicted < 0) return null;
      if (message !== null && typeof message !== 'string') return null;
      return { type: 'end', status: status as LlmStreamStatus, saved, conversationId, evicted, message };
    }
    default:
      return null;
  }
}

/** 주소 길이 상한. 사내 호스트 주소가 이보다 길 까닭이 없다 */
const BASE_URL_MAX = 500;

/**
 * LLM 주소 판정 (FR-1104). 통과하면 정규화한 주소 — 뒤에 `/chat/completions`·`/models`를 붙인다.
 *
 * - `http(s)`만. `javascript:`·`file:`은 서버가 부를 주소가 아니다
 * - **사용자 정보(`user:pass@`)·질의·조각을 받지 않는다.** 키가 주소에 섞이면 화면·감사로그로 나간다 — 키는 따로 받는다
 * - 끝의 `/`를 뗀다. 스킴·호스트의 대소문자는 URL 규칙대로 소문자가 된다
 *
 * 화면(등록 폼)과 서버(DTO)가 이 함수 하나를 쓴다.
 */
export function normalizeLlmBaseUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const value = raw.trim();
  if (value.length > BASE_URL_MAX) return { ok: false, reason: `주소가 너무 길다 (${BASE_URL_MAX}자까지)` };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, reason: '주소 형식이 아니다 — http://호스트:포트/v1 모양으로 적는다' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: '주소는 http 또는 https여야 한다' };
  if (!u.hostname) return { ok: false, reason: '주소 형식이 아니다 — 호스트가 없다' };
  if (u.username || u.password) return { ok: false, reason: '주소에 사용자 정보(아이디·비밀번호)를 넣지 않는다 — API 키는 따로 적는다' };
  if (u.search) return { ok: false, reason: '주소에 질의(?…)를 넣지 않는다 — API 키는 따로 적는다' };
  if (u.hash) return { ok: false, reason: '주소에 조각(#…)을 넣지 않는다' };
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${u.protocol}//${u.host}${path}` };
}
