import { Route, Routes } from 'react-router';
import { AuthProvider, RequireAuth } from './auth';
import { Layout } from './components/Layout';
import { AdminAuditPage } from './pages/admin/AdminAuditPage';
import { AdminHomePage } from './pages/admin/AdminHomePage';
import { AdminSpacesPage } from './pages/admin/AdminSpacesPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import { SystemPage } from './pages/admin/SystemPage';
import { ChangePasswordPage } from './pages/auth/ChangePasswordPage';
import { ContactPage } from './pages/auth/ContactPage';
import { FindIdPage } from './pages/auth/FindIdPage';
import { LandingPage } from './pages/auth/LandingPage';
import { RecoverPasswordPage } from './pages/auth/RecoverPasswordPage';
import { SignupPage } from './pages/auth/SignupPage';
import { HomePage } from './pages/HomePage';
import { PageEditorPage } from './pages/PageEditorPage';
import { PageHistoryPage } from './pages/PageHistoryPage';
import { SearchPage } from './pages/SearchPage';
import { SpacePage } from './pages/SpacePage';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LandingPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/find-id" element={<FindIdPage />} />
        <Route path="/recover-password" element={<RecoverPasswordPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<HomePage />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/spaces/:spaceId" element={<SpacePage />} />
          <Route path="/spaces/:spaceId/pages/:pageId" element={<SpacePage />} />
          <Route path="/spaces/:spaceId/new" element={<PageEditorPage />} />
          <Route path="/pages/:pageId/edit" element={<PageEditorPage />} />
          <Route path="/pages/:pageId/history" element={<PageHistoryPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/admin" element={<AdminHomePage />} />
          <Route path="/admin/users" element={<AdminUsersPage />} />
          <Route path="/admin/spaces" element={<AdminSpacesPage />} />
          <Route path="/admin/audit" element={<AdminAuditPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="*" element={<p>페이지를 찾을 수 없다.</p>} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
