import {
  Activity,
  ChartNoAxesCombined,
  SlidersHorizontal,
  FolderArchive,
  Bell,
  Database,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  RadioTower,
  Settings,
  Sun,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { demoMode, readOnlyMode, supabase } from '../services/supabase'
import { AlertInbox } from './AlertInbox'

const allNav = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/devices', label: 'Devices', icon: RadioTower },
  { to: '/analysis', label: 'Analysis', icon: ChartNoAxesCombined },
  { to: '/operations', label: 'Operations', icon: SlidersHorizontal },
  { to: '/library', label: 'Data library', icon: FolderArchive },
  { to: '/files', label: 'Data files', icon: Database },
  { to: '/settings', label: 'Settings', icon: Settings },
]
export function AppShell() {
  const nav = readOnlyMode ? allNav.filter((item) => ['/', '/devices', '/analysis'].includes(item.to)) : allNav
  const [menu, setMenu] = useState(false)
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')
  const [notices, setNotices] = useState(false)
  const [email, setEmail] = useState('Research team')
  const sidebarRef = useRef<HTMLElement>(null)
  const location = useLocation()
  const currentPage = location.pathname.startsWith('/device/')
    ? location.pathname.endsWith('/history')
      ? 'One-minute history'
      : 'Device dashboard'
    : (allNav.find((item) => item.to === location.pathname)?.label ?? 'Workspace')
  useEffect(() => {
    window.scrollTo(0, 0)
    setNotices(false)
  }, [location.pathname])
  useEffect(() => {
    if (!menu) return
    const previous = document.body.style.overflow
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    sidebarRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false)
      if (event.key === 'Tab') {
        const links = sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')
        if (!links?.length) return
        const first = links[0]
        const last = links[links.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onEscape)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onEscape)
      trigger?.focus({ preventScroll: true })
    }
  }, [menu])
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])
  useEffect(() => {
    if (!supabase || readOnlyMode) return
    void supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? 'Research team'))
  }, [])
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#workspace"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('workspace')?.focus()
        }}
      >
        Skip to content
      </a>
      <aside ref={sidebarRef} id="navigation" className={`sidebar ${menu ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">
            <Activity size={20} />
          </span>
          <span>
            <strong>AQ Observatory</strong>
            <small>Research network</small>
          </span>
          <button className="icon-btn close-menu" onClick={() => setMenu(false)} aria-label="Close menu">
            <X size={19} />
          </button>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Primary navigation">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={label} to={to} end={to === '/'} onClick={() => setMenu(false)}>
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="network-card">
          <div className="network-card-head">
            <FlaskConical size={16} /> Research mode
          </div>
          <p>Full-resolution data remains safely on each logger's SD card.</p>
          {!readOnlyMode && (
            <Link className="mini-link" to="/settings" onClick={() => setMenu(false)}>
              About this workspace ↗
            </Link>
          )}
        </div>
        <div className="profile">
          <div className="avatar">{demoMode ? 'AR' : readOnlyMode ? 'PV' : email.slice(0, 2).toUpperCase()}</div>
          <div>
            <strong>{demoMode ? 'Research team' : readOnlyMode ? 'Public viewer' : email}</strong>
            <small>{demoMode ? 'Demo workspace' : readOnlyMode ? 'Read-only access' : 'Authenticated user'}</small>
          </div>
          {!demoMode && !readOnlyMode && (
            <button
              className="icon-btn profile-logout"
              onClick={() => void supabase?.auth.signOut()}
              aria-label="Sign out"
            >
              <LogOut size={15} />
            </button>
          )}
        </div>
      </aside>
      {menu && <button className="backdrop" onClick={() => setMenu(false)} aria-label="Close navigation" />}
      <main className="main" id="workspace" tabIndex={-1}>
        <header className="topbar">
          <button
            className="icon-btn menu-btn"
            onClick={() => setMenu(true)}
            aria-label="Open menu"
            aria-expanded={menu}
            aria-controls="navigation"
          >
            <Menu size={20} />
          </button>
          <div className="topbar-context">
            <span className="live-pulse" /> {currentPage}
          </div>
          <div className="topbar-actions">
            {demoMode && <span className="demo-badge">Demo data</span>}
            {readOnlyMode && !demoMode && <span className="demo-badge public">Public view</span>}
            <div className="notice-wrap">
              <button
                className="icon-btn"
                onClick={() => setNotices((value) => !value)}
                aria-expanded={notices}
                aria-label="Notifications"
              >
                <Bell size={18} />
              </button>
              {!readOnlyMode && <AlertInbox open={notices} />}
              {readOnlyMode && notices && (
                <div className="notice-popover">
                  <strong>Public workspace</strong>
                  <p>Operational alerts are available to signed-in researchers.</p>
                </div>
              )}
            </div>
            <button className="icon-btn" onClick={() => setDark(!dark)} aria-label="Toggle colour theme">
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>
        <Outlet />
      </main>
    </div>
  )
}
