import { BrowserRouter, Route, Routes } from 'react-router';
import { AuthProvider, RequireAuth, useAuth } from './auth';
import { AppLayout } from './layout/AppLayout';
import { AuthLayout } from './layout/AuthLayout';
import { NotFoundPage } from './components/RequireUuidParam';
import { RequireUuidParam } from './components/RequireUuidParam';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { EmailHelpPage } from './pages/EmailHelpPage';
import { FindAccountPage } from './pages/FindAccountPage';
import { PageEditorPage } from './pages/PageEditorPage';
import { PageHistoryPage } from './pages/PageHistoryPage';
import { PageViewPage } from './pages/PageViewPage';
import { LabelPage } from './pages/LabelPage';
import { LlmPage } from './pages/LlmPage';
import { LlmPromptsPage } from './pages/LlmPromptsPage';
import { ApiTokensPage } from './pages/ApiTokensPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { SearchPage } from './pages/SearchPage';
import { TrashPage } from './pages/TrashPage';
import { SpacePage } from './pages/SpacePage';
import { SpacesPage } from './pages/SpacesPage';
import { LoginPage } from './pages/LoginPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { RootIdHelpPage } from './pages/RootIdHelpPage';
import { SignupPage } from './pages/SignupPage';
import { AdminAuditPage } from './pages/admin/AdminAuditPage';
import { AdminLlmPage } from './pages/admin/AdminLlmPage';
import { AdminPolicyPage } from './pages/admin/AdminPolicyPage';
import { AdminSpacesPage } from './pages/admin/AdminSpacesPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';

/** 비밀번호를 바꿔야 하는 동안은 카드 틀(나갈 곳이 없다), 스스로 바꿀 때는 한 틀 (P17 설계서 J.3.7) */
function ChangePasswordRoute() {
  const { me } = useAuth();
  return me?.mustChangePassword ? (
    <AuthLayout>
      <ChangePasswordPage />
    </AuthLayout>
  ) : (
    <AppLayout>
      <ChangePasswordPage />
    </AppLayout>
  );
}

/**
 * 화면 라우팅 (P1_설계서_Auth 8절 · P17 설계서 J.3.1).
 *
 * **틀은 중첩 경로가 씌운다** — 로그인 전 화면은 카드 틀(`AuthLayout`), 로그인한 화면은 한 틀(`AppLayout`: 위 막대 + 왼쪽 칸 + 본문). 화면은
 * 틀을 스스로 그리지 않으므로 틀을 빠뜨린 화면이 생길 수 없다(FR-1850).
 *
 * 보호가 필요한 화면은 RequireAuth 아래에 둔다. **서버도 같은 판정을 한다** — 화면 보호는 편의이고 실제 방어는 가드다. 둘 중 하나만 있으면 안 된다.
 */
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/find-account" element={<FindAccountPage />} />
            <Route path="/find-account/root" element={<RootIdHelpPage />} />
            <Route path="/find-account/email" element={<EmailHelpPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
          </Route>
          <Route path="/change-password" element={<RequireAuth><ChangePasswordRoute /></RequireAuth>} />
          <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
            {/* Phase 2가 홈을 스페이스 목록으로 바꿨다 */}
            <Route path="/" element={<SpacesPage />} />
            <Route path="/admin/users" element={<AdminUsersPage />} />
            <Route path="/admin/audit" element={<AdminAuditPage />} />
            <Route path="/admin/spaces" element={<AdminSpacesPage />} />
            <Route path="/admin/policy" element={<AdminPolicyPage />} />
            <Route path="/admin/llm" element={<AdminLlmPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/account/tokens" element={<ApiTokensPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/labels/:name" element={<LabelPage />} />
            {/* Phase 10 — 사내 LLM 질문 (P10_설계서_Llm G절). `/llm/prompts`는 고정 경로라 `/llm/:id`보다 먼저 맞는다 */}
            <Route path="/llm" element={<RequireUuidParam><LlmPage /></RequireUuidParam>} />
            <Route path="/llm/prompts" element={<LlmPromptsPage />} />
            <Route path="/llm/:id" element={<RequireUuidParam><LlmPage /></RequireUuidParam>} />
            <Route path="/spaces/:id" element={<RequireUuidParam><SpacePage /></RequireUuidParam>} />
            <Route path="/pages/:id" element={<RequireUuidParam><PageViewPage /></RequireUuidParam>} />
            <Route path="/pages/:id/edit" element={<RequireUuidParam><PageEditorPage /></RequireUuidParam>} />
            <Route path="/pages/:id/history" element={<RequireUuidParam><PageHistoryPage /></RequireUuidParam>} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
