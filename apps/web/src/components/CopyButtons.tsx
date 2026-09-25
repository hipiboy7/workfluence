import { pageMarkdown, pageText, type DocNode } from '@workfluence/shared';
import { useState } from 'react';
import { writeClipboard } from './clipboard';

/**
 * 페이지 보기의 **"텍스트 복사"·"마크다운 복사"** (P10_설계서_Llm FR-1140~1143).
 *
 * 위키 내용을 LLM에 넣는 길은 이것뿐이다 — 서버가 페이지를 LLM에 보내지 않는다(쟁점 4). 무엇이 LLM 서버로 가는지 사람이 보고
 * 붙인다. 변환은 공유 패키지의 순수 함수(`pageText`·`pageMarkdown`)다. **복사는 감사하지 않는다** — 글을 골라 Ctrl+C 하는 것과
 * 같다(A.1-9).
 */
export function CopyButtons({ title, content }: { title: string; content: DocNode }) {
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = async (kind: 'text' | 'markdown') => {
    setDone(null);
    setError(null);
    try {
      await writeClipboard(kind === 'markdown' ? pageMarkdown(title, content) : pageText(title, content));
      setDone(kind === 'markdown' ? '마크다운을 복사했다' : '텍스트를 복사했다');
    } catch {
      setError('복사하지 못했다 — 브라우저가 클립보드를 막았다');
    }
  };

  return (
    <>
      <button type="button" className="linklike" onClick={() => void copy('text')}>
        텍스트 복사
      </button>
      {' · '}
      <button type="button" className="linklike" onClick={() => void copy('markdown')}>
        마크다운 복사
      </button>
      {done && (
        <span role="status" className="muted small">
          {' '}
          {done}
        </span>
      )}
      {error && (
        <span role="alert" className="badge fail">
          {error}
        </span>
      )}
    </>
  );
}
