import { Activity, Bell, Database, FlaskConical, LayoutDashboard, Menu, Moon, RadioTower, Settings, Sun, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { demoMode } from '../services/supabase'

const nav = [{ to: '/', label: 'Overview', icon: LayoutDashboard }, { to: '/devices', label: 'Devices', icon: RadioTower }, { to: '/files', label: 'Data files', icon: Database }, { to: '/settings', label: 'Settings', icon: Settings }]
export function AppShell() {
  const [menu, setMenu] = useState(false); const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('theme', dark ? 'dark' : 'light') }, [dark])
  return <div className="app-shell">
    <aside className={`sidebar ${menu ? 'open' : ''}`}>
      <div className="brand"><span className="brand-mark"><Activity size={20} /></span><span><strong>AQ Observatory</strong><small>Research network</small></span><button className="icon-btn close-menu" onClick={() => setMenu(false)} aria-label="Close menu"><X size={19} /></button></div>
      <nav aria-label="Primary navigation">{nav.map(({ to, label, icon: Icon }) => <NavLink key={label} to={to} end={to === '/'} onClick={() => setMenu(false)}><Icon size={18} /><span>{label}</span></NavLink>)}</nav>
      <div className="network-card"><div className="network-card-head"><FlaskConical size={16} /> Research mode</div><p>Full-resolution data remains safely on each logger's SD card.</p><span className="mini-link">Storage architecture ↗</span></div>
      <div className="profile"><div className="avatar">AR</div><div><strong>Research team</strong><small>Administrator</small></div><button className="more">•••</button></div>
    </aside>
    {menu && <button className="backdrop" onClick={() => setMenu(false)} aria-label="Close navigation" />}
    <main className="main">
      <header className="topbar"><button className="icon-btn menu-btn" onClick={() => setMenu(true)} aria-label="Open menu"><Menu size={20} /></button><div className="topbar-context"><span className="live-pulse" /> Network operational</div><div className="topbar-actions">{demoMode && <span className="demo-badge">Demo data</span>}<button className="icon-btn" aria-label="Notifications"><Bell size={18} /></button><button className="icon-btn" onClick={() => setDark(!dark)} aria-label="Toggle colour theme">{dark ? <Sun size={18} /> : <Moon size={18} />}</button></div></header>
      <Outlet />
    </main>
  </div>
}
