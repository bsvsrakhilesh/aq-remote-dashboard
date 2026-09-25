import { Route, Routes } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AppShell } from './components/AppShell'
import { FleetPage } from './pages/FleetPage'
import { AuthGate } from './components/AuthGate'
import { NotFoundPage } from './pages/NotFoundPage'
import { readOnlyMode } from './services/supabase'

const DevicePage = lazy(() => import('./pages/DevicePage').then((module) => ({ default: module.DevicePage })))
const MinuteHistoryPage = lazy(() =>
  import('./pages/MinuteHistoryPage').then((module) => ({ default: module.MinuteHistoryPage })),
)
const FilesPage = lazy(() => import('./pages/FilesPage').then((module) => ({ default: module.FilesPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })))

export default function App() {
  return (
    <AuthGate>
      <Suspense fallback={<div className="route-loading">Loading workspace...</div>}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<FleetPage />} />
            <Route path="devices" element={<FleetPage />} />
            <Route path="device/:code" element={<DevicePage />} />
            <Route path="device/:code/history" element={<MinuteHistoryPage />} />
            <Route path="files" element={readOnlyMode ? <NotFoundPage /> : <FilesPage />} />
            <Route path="settings" element={readOnlyMode ? <NotFoundPage /> : <SettingsPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </AuthGate>
  )
}
