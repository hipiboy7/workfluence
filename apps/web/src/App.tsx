import { BrowserRouter, Route, Routes } from 'react-router';
import { AuthProvider, RequireAuth } from './auth';
import { NotificationBell } from './components/NotificationBell';
import { RequireUuidParam } from './components/RequireUuidParam';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { FindAccountPage } from './pages/FindAccountPage';
import { PageEditorPage } from './pages/PageEditorPage';
import { PageHistoryPage } from './pages/PageHistoryPage';
import { PageViewPage } from './pages/PageViewPage';
import { LabelPage } from './pages/LabelPage';
import { LlmPage } from './pages/LlmPage';
import { LlmPromptsPage } from './pages/LlmPromptsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { SearchPage } from './pages/SearchPage';
import { TrashPage } from './pages/TrashPage';
import { SpacePage } from './pages/SpacePage';
import { SpacesPage } from './pages/SpacesPage';
import { LoginPage } from './pages/LoginPage';
import { RootIdHelpPage } from './pages/RootIdHelpPage';
import { SignupPage } from './pages/SignupPage';
import { AdminAuditPage } from './pages/admin/AdminAuditPage';
import { AdminLlmPage } from './pages/admin/AdminLlmPage';
import { AdminPolicyPage } from './pages/admin/AdminPolicyPage';
import { AdminSpacesPage } from './pages/admin/AdminSpacesPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';

/**
 * 화면 라우팅 (P1_설계서_Auth 8절).
 *
 * 보호가 필요한 화면은 RequireAuth로 감싼다. **서버도 같은 판정을 한다** — 화면 보호는
 * 편의이고 실제 방어는 가드다. 둘 중 하나만 있으면 안 된다.
 */
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* 모든 화면의 알림 영역 (P17 F-010 8번) — 로그인한 사람에게만 그린다 */}
        <NotificationBell />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/find-account" element={<FindAccountPage />} />
          <Route path="/find-account/root" element={<RootIdHelpPage />} />
          <Route path="/change-password" element={<RequireAuth><ChangePasswordPage /></RequireAuth>} />
          <Route path="/admin/users" element={<RequireAuth><AdminUsersPage /></RequireAuth>} />
          <Route path="/admin/audit" element={<RequireAuth><AdminAuditPage /></RequireAuth>} />
          <Route path="/admin/spaces" element={<RequireAuth><AdminSpacesPage /></RequireAuth>} />
          <Route path="/search" element={<RequireAuth><SearchPage /></RequireAuth>} />
          <Route path="/notifications" element={<RequireAuth><NotificationsPage /></RequireAuth>} />
          <Route path="/trash" element={<RequireAuth><TrashPage /></RequireAuth>} />
          <Route path="/labels/:name" element={<RequireAuth><LabelPage /></RequireAuth>} />
          <Route path="/admin/policy" element={<RequireAuth><AdminPolicyPage /></RequireAuth>} />
          {/* Phase 10 — 사내 LLM 질문 (P10_설계서_Llm G절). `/llm/prompts`는 고정 경로라 `/llm/:id`보다 먼저 맞는다 */}
          <Route path="/llm" element={<RequireAuth><RequireUuidParam><LlmPage /></RequireUuidParam></RequireAuth>} />
          <Route path="/llm/prompts" element={<RequireAuth><LlmPromptsPage /></RequireAuth>} />
          <Route path="/llm/:id" element={<RequireAuth><RequireUuidParam><LlmPage /></RequireUuidParam></RequireAuth>} />
          <Route path="/admin/llm" element={<RequireAuth><AdminLlmPage /></RequireAuth>} />
          <Route path="/spaces/:id" element={<RequireAuth><RequireUuidParam><SpacePage /></RequireUuidParam></RequireAuth>} />
          <Route path="/pages/:id" element={<RequireAuth><RequireUuidParam><PageViewPage /></RequireUuidParam></RequireAuth>} />
          <Route path="/pages/:id/edit" element={<RequireAuth><RequireUuidParam><PageEditorPage /></RequireUuidParam></RequireAuth>} />
          <Route path="/pages/:id/history" element={<RequireAuth><RequireUuidParam><PageHistoryPage /></RequireUuidParam></RequireAuth>} />
          {/* Phase 2가 홈을 스페이스 목록으로 바꿨다 */}
          <Route path="/" element={<RequireAuth><SpacesPage /></RequireAuth>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
