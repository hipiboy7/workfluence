import { LLM_LIMITS } from '@workfluence/shared';

/**
 * 답 맨 앞의 생각 과정 떼기 (A등급, P10_설계서_Llm D.2·FR-1119).
 *
 * reasoning parser를 켜지 않은 vLLM은 Qwen3의 생각 과정을 답 앞에 `<think>…</think>`로 그대로 흘린다. 태그는 조각 경계에서
 * 갈라져 온다(`<th` + `ink>`). **답의 맨 앞에서만** 생각 과정으로 본다 — 가운데의 `<think>`는 답의 글자다(HTML 태그를
 * 묻는 질문의 답일 수 있다). 생각 과정은 화면에 접어서 보이고 저장하지 않는다.
 *
 * **닫는 태그만 오는 모양** — Qwen3-*-Thinking-2507처럼 대화 틀이 `<think>`를 미리 넣는 모델은 `생각…</think>답`을 낸다. 앞에
 * 흘려보낸 것이 생각 과정이었다는 것은 `</think>`를 보고서야 안다. 그때 `rethink` 표지를 낸다 — "지금까지의 답은 생각 과정이었다".
 * **첫 번째 닫는 태그만**, 그리고 **답 안에 여는 태그가 먼저 없었을 때만** 그렇게 본다(짝이 있으면 태그를 묻는 답이다)
 * (검토 반영 — 코드 리뷰 14).
 */

export type Piece = { kind: 'answer' | 'thinking'; text: string } | { kind: 'rethink' };

const OPEN = '<think>';
const CLOSE = '</think>';

type State = 'start' | 'thinking' | 'afterThink' | 'answer';

/** `s`의 끝이 `tag`의 앞부분일 수 있는 가장 긴 길이 — 그만큼은 다음 조각을 보고 정한다 */
function partialTail(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

export function createThinkSplitter(): { push(text: string): Piece[]; end(): Piece[] } {
  let state: State = 'start';
  let buffer = '';
  /** 여는 태그로 시작했으면 짝을 맞춘 것이다 — 닫는 태그만 오는 모양을 보지 않는다 */
  let openedAtStart = false;
  /** 닫는 태그만 오는 모양을 이미 한 번 처리했다 — 그 뒤의 `</think>`는 답의 글자다 */
  let reclassified = false;
  /** 답 안에 여는 태그가 있었다 — 그 뒤의 닫는 태그는 짝이다 */
  let openSeenInAnswer = false;
  /** 여는 태그가 조각 경계에서 갈라져도 알아보도록 내보낸 답의 끝을 조금 들고 있는다 */
  let emittedTail = '';

  const emit = (out: Piece[], kind: 'answer' | 'thinking', text: string) => {
    if (!text) return;
    out.push({ kind, text });
    if (kind === 'answer') {
      if ((emittedTail + text).includes(OPEN)) openSeenInAnswer = true;
      emittedTail = (emittedTail + text).slice(-OPEN.length);
    }
  };

  /** 이 상태에서 닫는 태그만 오는 모양을 볼 것인가 */
  const watchOrphanClose = () => !openedAtStart && !reclassified && !openSeenInAnswer;

  const step = (out: Piece[]): void => {
    for (;;) {
      if (state === 'start') {
        const lead = buffer.length - buffer.trimStart().length;
        const rest = buffer.slice(lead);
        if (rest.startsWith(OPEN)) {
          // 여는 태그 앞의 빈칸은 버린다
          buffer = rest.slice(OPEN.length);
          state = 'thinking';
          openedAtStart = true;
          continue;
        }
        // 아직 `<think>`의 앞부분일 수 있으면(빈칸뿐이거나 `<th`까지) 다음 조각을 기다린다 — **빈칸이 끝없이 오면** 상한에서 답으로 넘긴다
        if (OPEN.startsWith(rest) && lead <= LLM_LIMITS.thinkLeadMaxChars) return;
        state = 'answer';
        continue;
      }
      if (state === 'thinking') {
        const at = buffer.indexOf(CLOSE);
        if (at >= 0) {
          emit(out, 'thinking', buffer.slice(0, at));
          buffer = buffer.slice(at + CLOSE.length);
          state = 'afterThink';
          continue;
        }
        const hold = partialTail(buffer, CLOSE);
        emit(out, 'thinking', buffer.slice(0, buffer.length - hold));
        buffer = buffer.slice(buffer.length - hold);
        return;
      }
      if (state === 'afterThink') {
        // 닫는 태그 뒤의 빈 줄은 답에 넣지 않는다 (Qwen3는 `</think>\n\n` 뒤에 답을 낸다)
        const trimmed = buffer.trimStart();
        if (!trimmed) {
          buffer = '';
          return;
        }
        buffer = trimmed;
        state = 'answer';
        continue;
      }
      // answer
      if (watchOrphanClose()) {
        const at = buffer.indexOf(CLOSE);
        const openAt = buffer.indexOf(OPEN);
        // 닫는 태그보다 여는 태그가 먼저면 짝이다 — 답의 글자로 둔다
        if (at >= 0 && (openAt < 0 || openAt > at) && !(emittedTail + buffer.slice(0, at)).includes(OPEN)) {
          emit(out, 'answer', buffer.slice(0, at));
          out.push({ kind: 'rethink' });
          reclassified = true;
          buffer = buffer.slice(at + CLOSE.length);
          state = 'afterThink';
          continue;
        }
        if (at < 0) {
          // 닫는 태그의 앞부분일 수 있는 끝은 다음 조각을 보고 정한다
          const hold = partialTail(buffer, CLOSE);
          emit(out, 'answer', buffer.slice(0, buffer.length - hold));
          buffer = buffer.slice(buffer.length - hold);
          return;
        }
      }
      // 이제부터는 받은 그대로다
      emit(out, 'answer', buffer);
      buffer = '';
      return;
    }
  };

  return {
    push(text: string): Piece[] {
      const out: Piece[] = [];
      if (!text) return out;
      buffer += text;
      step(out);
      return out;
    },
    end(): Piece[] {
      const out: Piece[] = [];
      // 붙들고 있던 것은 그 자리의 종류로 낸다 — `<thi`에서 끝나면 답, 생각 중에 끝나면(중지) 생각 과정
      if (state === 'thinking') emit(out, 'thinking', buffer);
      else if (state === 'start' || state === 'answer') emit(out, 'answer', buffer);
      buffer = '';
      return out;
    },
  };
}
