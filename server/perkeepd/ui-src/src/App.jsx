import { Navigate, Routes, Route } from "react-router-dom";

import AppLayout from "./components/layout/AppLayout.jsx";
import { useAuth } from "./hooks/useAuth.js";
import AccountPage from "./pages/AccountPage.jsx";
import DebugPage from "./pages/DebugPage.jsx";
import DetailPage from "./pages/DetailPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import MapPage from "./pages/MapPage.jsx";
import MobileSetupPage from "./pages/MobileSetupPage.jsx";
import SearchPage from "./pages/SearchPage.jsx";

// Everything under AppLayout needs a logged-in session (discovery/search/etc.
// all require a bearer token now -- see api/client.js) -- /login is the one
// route that has to work without one, so it's a sibling here, not nested
// under AppLayout/useDiscovery.
function RequireAuth({ children }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<SearchPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="map" element={<MapPage />} />
        <Route path="mobile-setup" element={<MobileSetupPage />} />
        <Route path="debug" element={<DebugPage />} />
        {/* Plain detail deep-links; AppLayout redirects the old "?p="/"?b=" shortlinks here too. */}
        <Route path="detail/:blobref" element={<DetailPage />} />
      </Route>
    </Routes>
  );
}
