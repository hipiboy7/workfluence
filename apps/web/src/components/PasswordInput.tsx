import { useState } from 'react';

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  placeholder?: string;
  minLength?: number;
};

/**
 * 비밀번호 입력 + 눈 아이콘 (prototype-v2 2절 6번).
 * 기본은 감은 눈(마스킹). 누르면 뜬 눈이 되고 비밀번호가 보인다. 아이콘은 인라인 SVG (외부 자원 없음).
 */
export function PasswordInput({ id, value, onChange, autoComplete, required, placeholder, minLength }: Props) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-field">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        placeholder={placeholder}
        minLength={minLength}
      />
      <button
        type="button"
        className="eye"
        aria-label={show ? '비밀번호 숨기기' : '비밀번호 보기'}
        aria-pressed={show}
        title={show ? '비밀번호 숨기기' : '비밀번호 보기'}
        onClick={() => setShow((s) => !s)}
      >
        {show ? <EyeOpen /> : <EyeClosed />}
      </button>
    </div>
  );
}

function EyeOpen() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeClosed() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 13c2.5 3 5.5 4.5 9 4.5s6.5-1.5 9-4.5" />
      <path d="M12 17.5V20" />
      <path d="M7.5 16.5 6 19" />
      <path d="M16.5 16.5 18 19" />
    </svg>
  );
}
