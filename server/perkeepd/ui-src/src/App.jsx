import { Routes, Route } from "react-router-dom";

import AppLayout from "./components/layout/AppLayout.jsx";
import SearchPage from "./pages/SearchPage.jsx";
import DetailPage from "./pages/DetailPage.jsx";
import MapPage from "./pages/MapPage.jsx";
import MobileSetupPage from "./pages/MobileSetupPage.jsx";
import DebugPage from "./pages/DebugPage.jsx";

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<SearchPage />} />
        <Route path="map" element={<MapPage />} />
        <Route path="mobile-setup" element={<MobileSetupPage />} />
        <Route path="debug" element={<DebugPage />} />
        {/* Plain detail deep-links; AppLayout redirects the old "?p="/"?b=" shortlinks here too. */}
        <Route path="detail/:blobref" element={<DetailPage />} />
      </Route>
    </Routes>
  );
}
