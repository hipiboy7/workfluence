import { LLM_LIMITS } from '@workfluence/shared';
import type { ChatMessage } from './openai';

/** 대화 규칙 (A등급, P10_설계서_Llm D.2·D.5, FR-1119·1127·1131·1133) */

const DAY_MS = 86_400_000;

/**
 * 제목 — 첫 질문의 **첫 줄**에서 `LLM_LIMITS.titleChars`자. **글자(코드 포인트) 단위로** 자른다 — 한글·이모지가 반쪽으로
 * 깨지지 않게. 이름 바꾸기는 두지 않았다(설계서 G절).
 */
export function conversationTitle(question: string): string {
  const first = question
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return '(제목 없음)';
  const chars = Array.from(first);
  return chars.length > LLM_LIMITS.titleChars ? `${chars.slice(0, LLM_LIMITS.titleChars).join('')}…` : first;
}

export type HistoryMessage = { role: 'user' | 'assistant'; content: string };

/**
 * LLM에 보내는 것 (D.2) — 지시문(있으면) · 앞 이력 · 이번 질문.
 *
 * 이력의 답은 **이미 생각 과정을 뺀 것**이다(저장할 때 뺐다, FR-1119). 빈 답(중지돼 글자가 없던 것)은 넣지 않는다.
 * **앞에서 자르지 않는다** — 길면 LLM 서버가 거절하고 화면이 그렇게 말한다(D.3).
 */
export function buildChatMessages(systemPrompt: string | null, history: HistoryMessage[], question: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (systemPrompt && systemPrompt.trim()) out.push({ role: 'system', content: systemPrompt });
  for (const m of history) {
    if (m.role === 'assistant' && !m.content.trim()) continue;
    out.push({ role: m.role, content: m.content });
  }
  out.push({ role: 'user', content: question });
  return out;
}

/** 이 시각보다 `retain_from`이 앞선 고정하지 않은 대화는 만료다 (FR-1131) */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** 고정하지 않은 대화가 지워지는 시각 — 화면의 "N일 뒤 지워짐" */
export function expiresAt(retainFrom: Date, days: number): Date {
  return new Date(retainFrom.getTime() + days * DAY_MS);
}

/** 고정할 수 있나 (FR-1133). 상한을 지금 고정 수보다 낮춘 경우에도 새 고정은 막는다 — 있던 고정은 풀지 않는다(D.5) */
export function canPin(pinnedCount: number, pinnedMax: number): boolean {
  return pinnedCount < pinnedMax;
}
