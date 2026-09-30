import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { PASSWORD_RESET } from '@workfluence/shared';
import { api } from '../api';
import { AuthBrand } from '../layout/AuthLayout';
import { Field, FormActions, Notice, useDocumentTitle } from '../components/ui';

type SetError = (message: string | null) => void;

/** 비밀번호 찾기의 결과 — 어느 길로 보냈나 */
type Sent = 'mail' | 'admin' | null;

/** 결과 문장 — 맞았는지는 말하지 않는다(계정 열거 방지). 시험이 앞머리로 찾는다 */
export const SENT_MAIL = `요청을 받았다. 이름과 email이 맞으면 그 email로 재설정 링크가 간다 — ${PASSWORD_RESET.linkMinutes}분 안에 연다. 메일이 오지 않으면 관리자에게 초기화를 요청한다.`;
export const SENT_ADMIN = '요청을 접수했다. 이름과 email이 맞으면 관리자의 알림에 간다 — 관리자가 초기화한 임시 비밀번호를 받아 로그인한다.';

/**
 * 아이디 찾기와 비밀번호 찾기 (FR-208, FR-209a · P19 FR-2000·2013).
 *
 * **결과가 없어도 "없다"고 말하지 않는다** — 그 자체가 계정 존재를 알려 준다. 비밀번호는 여기서 발급하지 않는다(P1 2.4절).
 *
 * 비밀번호 찾기는 **두 길**이다(P19 — 사용자 원문 1·2번) — **내 email로 재설정 링크 받기**(메일 재설정을 쓸 수 있을 때만 — 서버가 `/api/auth/config`로
 * 알린다, FR-2008)와 **관리자에게 초기화 요청**. 두 길 모두 **표시 이름 + 가입할 때 넣은 email**이다(원문 3번). 폼을 보내면(Enter) 앞의 길이다.
 * email 칸의 라벨 줄 오른쪽 끝에 **이메일이 기억이 안나시나요?**(원문 4번 — 안내 화면 `/find-account/email`).
 *
 * 카드 틀(P17 설계서 J.6) — 두 카드를 나란히 두고, **오류와 결과는 각자 카드 안**에 둔다. 카드가 곧 폼이다 — 시험이 "비밀번호 찾기" 제목을 품은 폼 안에서
 * 칸과 결과를 찾는다. 화면의 h1은 보조기기에만 읽힌다 — 보이는 제목은 두 카드의 제목이 이미 말한다
 */
export function FindAccountPage() {
  const [id, setId] = useState({ email: '', displayName: '' });
  const [pw, setPw] = useState({ displayName: '', email: '' });
  const [idResult, setIdResult] = useState<string | null | undefined>(undefined);
  const [sent, setSent] = useState<Sent>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [mailOn, setMailOn] = useState(false);
  useDocumentTitle('아이디·비밀번호 찾기');

  useEffect(() => {
    let live = true;
    api<{ resetMailEnabled?: boolean }>('/api/auth/config')
      .then((c) => live && setMailOn(c.resetMailEnabled === true))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const run = async (setError: SetError, fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const request = (via: 'mail' | 'admin') =>
    run(setPwError, async () => {
      setSent(null);
      await api<{ ok: true }>(via === 'mail' ? '/api/auth/reset-mail' : '/api/auth/recover-password', { method: 'POST', json: pw });
      setSent(via);
    });

  return (
    <>
      <AuthBrand />
      <h1 className="sr-only">아이디·비밀번호 찾기</h1>
      <div className="auth-cards">
        <form
          className="auth-card form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(setIdError, async () => setIdResult((await api<{ username: string | null }>('/api/auth/find-id', { method: 'POST', json: id })).username));
          }}
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
          <Field id="fi-email" label="email" required>
            <input id="fi-email" className="w-full" type="email" value={id.email} onChange={(e) => setId({ ...id, email: e.target.value })} />
          </Field>
          <Field id="fi-name" label="이름" required>
            <input id="fi-name" className="w-full" value={id.displayName} onChange={(e) => setId({ ...id, displayName: e.target.value })} />
          </Field>
          <FormActions>
            <button type="submit" className="primary">
              찾기
            </button>
          </FormActions>
        </form>

        <form
          className="auth-card wide form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void request(mailOn ? 'mail' : 'admin');
          }}
        >
          <h2>비밀번호 찾기</h2>
          <p className="muted small">
            {mailOn ? (
              <>
                둘 가운데 하나를 고른다 — <strong>내 email로 링크를 받아 스스로 바꾸거나</strong>, 관리자에게 초기화를 부탁한다. 두 길 모두 이름과 가입할 때 넣은
                email이 맞아야 한다.
              </>
            ) : (
              <>
                비밀번호는 이 화면에서 바로 바꿔 드리지 않는다. 요청을 남기면 <strong>관리자가 확인하고 초기화</strong>한다. 이름과 가입할 때 넣은 email이 맞아야 한다.
              </>
            )}
          </p>
          {pwError && <Notice kind="error">{pwError}</Notice>}
          {sent && <Notice kind="success">{sent === 'mail' ? SENT_MAIL : SENT_ADMIN}</Notice>}
          <Field id="fp-name" label="이름" required>
            <input id="fp-name" className="w-full" value={pw.displayName} onChange={(e) => setPw({ ...pw, displayName: e.target.value })} />
          </Field>
          <Field id="fp-email" label="email" required aside={<Link to="/find-account/email">이메일이 기억이 안나시나요?</Link>}>
            <input id="fp-email" className="w-full" type="email" value={pw.email} onChange={(e) => setPw({ ...pw, email: e.target.value })} />
          </Field>
          <FormActions>
            {mailOn ? (
              <>
                <button type="submit" className="primary">
                  내 email로 재설정 링크 받기
                </button>
                <button type="button" onClick={() => void request('admin')}>
                  관리자에게 초기화 요청
                </button>
              </>
            ) : (
              <button type="submit" className="primary">
                관리자에게 초기화 요청
              </button>
            )}
          </FormActions>
          {mailOn && <p className="muted small">시스템 관리자(root)는 메일로 바꾸지 않는다 — 다른 시스템 관리자나 서버 담당자에게 부탁한다.</p>}
        </form>
      </div>
      <p className="auth-links">
        <Link to="/login">← 로그인으로</Link>
      </p>
    </>
  );
}
