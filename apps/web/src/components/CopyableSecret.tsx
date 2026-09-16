import { useEffect, useState } from 'react';

/**
 * 임시 비밀번호처럼 한 번만 보이는 값. 누르면 클립보드로 복사되고 "복사 되었습니다"가 잠시 뜬다.
 * 클립보드 API는 보안 컨텍스트(HTTPS 또는 localhost)에서만 동작하므로, 실패하면 값을 선택해 직접 복사하도록 안내한다.
 */
export function CopyableSecret({ value, label = '임시 비밀번호' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
      selectValue();
    }
  };

  const selectValue = () => {
    const el = document.getElementById(`secret-${label}`);
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  return (
    <span className="copyable">
      <button type="button" className="secret" onClick={copy} title="눌러서 클립보드로 복사">
        <span id={`secret-${label}`} className="mono big">
          {value}
        </span>
        <CopyIcon />
      </button>
      {state === 'copied' && <span className="copied-flash">복사 되었습니다</span>}
      {state === 'failed' && <span className="copied-flash failed">복사할 수 없습니다. 값을 선택해 직접 복사하세요</span>}
    </span>
  );
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
