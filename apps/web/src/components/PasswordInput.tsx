import { useState } from 'react';

/**
 * 비밀번호 칸과 눈 모양 단추 (P17 F-010 1번). 처음은 **감은 눈**이고 가린다. 누르면 **뜬 눈**이 되고 글자로 보인다. 다시 누르면 가린다.
 * 그림은 이 파일 안의 SVG다 — 외부 자원을 쓰지 않는다(`CLAUDE.md` 7절).
 *
 * `Field`(P17 설계서 J.5.3) 안에 둔다 — `Field`가 도움말·오류를 `aria-describedby`·`aria-invalid`로 넘기면 칸에 그대로 붙인다.
 * **비밀번호 변경 화면에만 쓴다** — 로그인·가입·API 키 칸에 두면 "비밀번호"로 칸을 찾는 이름 찾기가 이 단추에도 걸린다(J.5.3)
 */
export function PasswordInput({
  id,
  name,
  value,
  onChange,
  autoComplete,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  required,
}: {
  id: string;
  /** 단추의 이름에 쓴다 — "새 비밀번호 보이기" */
  name: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  required?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="pw-field">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        required={required}
        spellCheck={false}
      />
      <button type="button" className="pw-eye" aria-label={`${name} ${shown ? '가리기' : '보이기'}`} aria-pressed={shown} onClick={() => setShown((v) => !v)}>
        {shown ? <EyeOpen /> : <EyeClosed />}
      </button>
    </div>
  );
}

const EyeOpen = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
    <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" strokeWidth="2" />
    <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
);

const EyeClosed = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
    <path d="M2 10c2.6 3.4 6 5.2 10 5.2s7.4-1.8 10-5.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M5.2 13.6 3.5 16M9.3 15 8.8 18M14.7 15l.5 3M18.8 13.6 20.5 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
