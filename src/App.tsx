import { Navigate, Route, Routes } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AppShell } from './components/AppShell'
import { FleetPage } from './pages/FleetPage'
import { AuthGate } from './components/AuthGate'

const DevicePage = lazy(() => import('./pages/DevicePage').then(module => ({ default: module.DevicePage })))
const FilesPage = lazy(() => import('./pages/FilesPage').then(module => ({ default: module.FilesPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(module => ({ default: module.SettingsPage })))

export default function App() {
  return <AuthGate><Suspense fallback={<div className="route-loading">Loading workspace...</div>}><Routes><Route element={<AppShell />}><Route index element={<FleetPage />} /><Route path="devices" element={<FleetPage />} /><Route path="device/:code" element={<DevicePage />} /><Route path="files" element={<FilesPage />} /><Route path="settings" element={<SettingsPage />} /></Route><Route path="*" element={<Navigate to="/" replace />} /></Routes></Suspense></AuthGate>
}
