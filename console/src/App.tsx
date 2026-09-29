import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { TelemetryProvider } from "./hooks/useTelemetry";
import { Shell } from "./app/Shell";
import { OverviewPage } from "./pages/Overview";
import { StreamPage } from "./pages/Stream";
import { HostsPage } from "./pages/Hosts";
import { TopologyPage } from "./pages/Topology";
import { GatewayPage } from "./pages/Gateway";
import { PlaygroundPage } from "./pages/Playground";
import { ClusterPage } from "./pages/Cluster";
import { SettingsPage } from "./pages/Settings";

export default function App() {
  return (
    <TelemetryProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<OverviewPage />} />
            <Route path="stream" element={<StreamPage />} />
            <Route path="hosts" element={<HostsPage />} />
            <Route path="topology" element={<TopologyPage />} />
            <Route path="gateway" element={<GatewayPage />} />
            <Route path="playground" element={<PlaygroundPage />} />
            <Route path="cluster" element={<ClusterPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </TelemetryProvider>
  );
}