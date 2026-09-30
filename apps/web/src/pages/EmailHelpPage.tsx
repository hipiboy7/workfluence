import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { AuthBrand } from '../layout/AuthLayout';
import { Field, FormActions, Notice, useDocumentTitle } from '../components/ui';

/** 결과 문장 — 맞았는지는 말하지 않는다(계정 열거 방지) */
export const HELP_SENT = '요청을 보냈다. 아이디와 이름이 맞으면 시스템 관리자의 알림에 간다 — 시스템 관리자가 본인인지 확인한 뒤 연락한다.';

const TITLE = '이메일이 기억나지 않을 때';

/**
 * **"이메일이 기억이 안나시나요?"** (P19 FR-2009 — 사용자 원문 4번 "시스템 관리자에게 확인 요청이 가도록 하는 문구로 안내하고, 시스템 관리자에게 알람").
 * 비밀번호 찾기의 email 칸 옆에서 온다. **아이디 + 표시 이름**을 보낸다(착수 쟁점 2). 맞는 활성 계정일 때만 시스템 관리자의 알림에 가고, 응답은 늘 같다 —
 * 이 화면은 누구의 email도 보여 주지 않는다.
 *
 * 카드 틀(P17 설계서 J.6 — 안내 카드처럼 카드 제목이 h1). **← 비밀번호 찾기로**는 카드 아래의 조치다(J.3.5)
 */
export function EmailHelpPage() {
  const [form, setForm] = useState({ username: '', displayName: '' });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle(TITLE);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSent(false);
    try {
      await api<{ ok: true }>('/api/auth/email-help', { method: 'POST', json: form });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <AuthBrand />
      <form className="auth-card wide form-stack" onSubmit={(e) => void submit(e)}>
        <h1>{TITLE}</h1>
        <p>
          가입할 때 넣은 email이 기억나지 않으면 <strong>시스템 관리자에게 확인을 요청</strong>한다. 아이디와 이름을 적어 보내면 시스템 관리자의 알림에 간다 —
          시스템 관리자가 본인인지 확인한 뒤 연락한다.
        </p>
        {error && <Notice kind="error">{error}</Notice>}
        {sent && <Notice kind="success">{HELP_SENT}</Notice>}
        <Field id="eh-username" label="아이디" required>
          <input id="eh-username" className="w-full" autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </Field>
        <Field id="eh-name" label="이름" required>
          <input id="eh-name" className="w-full" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </Field>
        <FormActions>
          <button type="submit" className="primary">
            시스템 관리자에게 확인 요청
          </button>
        </FormActions>
        <p className="muted small">
          아이디도 기억나지 않으면 <Link to="/find-account">아이디 찾기</Link>(email과 이름)를 쓰거나, 시스템 관리자·관리자에게 직접 알린다.
        </p>
      </form>
      <p className="auth-links">
        <Link to="/find-account">← 비밀번호 찾기로</Link>
      </p>
    </>
  );
}
