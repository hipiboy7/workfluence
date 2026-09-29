import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { AuthBrand } from '../layout/AuthLayout';
import { Field, FormActions, Notice, useDocumentTitle } from '../components/ui';

type SetError = (message: string | null) => void;

/**
 * 아이디 찾기와 비밀번호 초기화 **요청** (FR-208, FR-209a).
 *
 * **결과가 없어도 "없다"고 말하지 않는다** — 그 자체가 계정 존재를 알려 준다.
 * 비밀번호는 여기서 발급하지 않는다. 미인증 화면이 비밀번호를 내주면 아이디와 사내 email을
 * 아는 사람이 곧 계정 소유자가 된다 (P1_설계서_Auth 2.4절).
 *
 * 카드 틀(P17 설계서 J.6) — 두 카드를 나란히 두고, **오류와 결과는 각자 카드 안**에 둔다. 예전에는 오류 칸 하나를 두 폼이 같이 써서 아래 폼의
 * 오류가 위에 떴다. 카드가 곧 폼이다 — 시험이 "비밀번호 찾기" 제목을 품은 폼 안에서 칸과 결과를 찾는다. 화면의 h1은 보조기기에만 읽힌다 —
 * 보이는 제목은 두 카드의 제목이 이미 말한다
 */
export function FindAccountPage() {
  const [id, setId] = useState({ email: '', displayName: '' });
  const [pw, setPw] = useState({ username: '', email: '' });
  const [idResult, setIdResult] = useState<string | null | undefined>(undefined);
  const [pwSent, setPwSent] = useState(false);
  const [idError, setIdError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  useDocumentTitle('아이디·비밀번호 찾기');

  const run = async (e: FormEvent, setError: SetError, fn: () => Promise<void>) => {
    e.preventDefault();
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <AuthBrand />
      <h1 className="sr-only">아이디·비밀번호 찾기</h1>
      <div className="auth-cards">
        <form
          className="auth-card form-stack"
          onSubmit={(e) =>
            run(e, setIdError, async () => setIdResult((await api<{ username: string | null }>('/api/auth/find-id', { method: 'POST', json: id })).username))
          }
        >
          <h2>아이디 찾기</h2>
          {idError && <Notice kind="error">{idError}</Notice>}
          {idResult !== undefined && (
            <Notice kind="info">
              {idResult ? (
                <>
                  아이디: <strong>{idResult}</strong> (일부만 표시된다)
                </>
              ) : (
                '일치하는 정보로 찾을 수 없다. 관리자에게 문의한다.'
              )}
            </Notice>
          )}
          <Field id="fi-email" label="email">
            <input id="fi-email" className="w-full" type="email" value={id.email} onChange={(e) => setId({ ...id, email: e.target.value })} required />
          </Field>
          <Field id="fi-name" label="이름">
            <input id="fi-name" className="w-full" value={id.displayName} onChange={(e) => setId({ ...id, displayName: e.target.value })} required />
          </Field>
          <FormActions>
            <button type="submit" className="primary">
              찾기
            </button>
          </FormActions>
        </form>

        <form
          className="auth-card form-stack"
          onSubmit={(e) =>
            run(e, setPwError, async () => {
              await api<{ ok: true }>('/api/auth/recover-password', { method: 'POST', json: pw });
              setPwSent(true);
            })
          }
        >
          <h2>비밀번호 찾기</h2>
          <p className="muted small">
            비밀번호는 이 화면에서 바로 바꿔 드리지 않는다. 요청을 남기면 <strong>관리자가 확인하고 초기화</strong>한다.
          </p>
          {pwError && <Notice kind="error">{pwError}</Notice>}
          {pwSent && (
            <Notice kind="success">요청을 접수했다. 아이디와 email이 맞으면 관리자의 알림에 간다 — 관리자가 초기화한 임시 비밀번호를 받아 로그인한다.</Notice>
          )}
          <Field id="fp-username" label="아이디">
            <input id="fp-username" className="w-full" value={pw.username} onChange={(e) => setPw({ ...pw, username: e.target.value })} required />
          </Field>
          <Field id="fp-email" label="email">
            <input id="fp-email" className="w-full" type="email" value={pw.email} onChange={(e) => setPw({ ...pw, email: e.target.value })} required />
          </Field>
          <FormActions>
            <button type="submit" className="primary">
              초기화 요청
            </button>
          </FormActions>
        </form>
      </div>
      <p className="auth-links">
        <Link to="/login">← 로그인으로</Link>
      </p>
    </>
  );
}
