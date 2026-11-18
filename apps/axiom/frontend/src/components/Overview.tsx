import { useMemo, useState } from 'react'
import { ArrowRight, Activity, ChartNoAxesCombined, Database, FileSpreadsheet, FlaskConical, Search, ShieldCheck, Sigma, Upload, X } from 'lucide-react'
import type { Catalog } from '../types'

export type WorkspaceView = 'overview' | 'series' | 'statistics' | 'collocation'
interface Props {
  catalog: Catalog
  onNavigate: (view: WorkspaceView) => void
  onDataset: (id: string) => void
  onImport: () => void
}

export default function Overview({ catalog, onNavigate, onDataset, onImport }: Props) {
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(12)
  const datasets = useMemo(() => catalog.monitors.filter(item => `${item.name} ${item.filename}`.toLowerCase().includes(search.toLowerCase())), [catalog, search])
  return <>
    <section className="page-heading">
      <div><div className="eyebrow"><Activity size={14} /> Your research workspace</div><h1>See the signal. Understand the data.</h1><p>From your first observation to an analysis you can explain.</p></div>
      <button className="button primary" onClick={onImport}><Upload size={16} /> Import dataset</button>
    </section>
    <section className="overview-hero">
      <div className="hero-copy"><span className="hero-kicker">A clearer path from data to evidence</span><h2>Explore with curiosity.<br />Conclude with confidence.</h2><p>Inspect data quality, investigate patterns, and compare sensors with transparent statistical methods.</p><button onClick={() => catalog.monitors.length ? onNavigate('statistics') : onImport()}>{catalog.monitors.length ? 'Open statistics' : 'Import your first dataset'} <ArrowRight size={17} /></button></div>
      <div className="signal-art" aria-hidden="true"><div className="signal-grid" /><svg viewBox="0 0 480 200" fill="none"><path d="M0 140 C35 140 30 120 60 125 S95 175 120 135 S140 80 165 100 S190 150 210 80 S240 110 265 60 S300 90 320 50 S345 100 365 65 S400 40 420 50 S450 5 480 25" stroke="currentColor" strokeWidth="2.5" /><path d="M0 160 C40 150 60 180 90 155 S140 120 170 135 S200 80 230 115 S280 130 310 105 S340 80 370 100 S420 65 450 80 S460 45 480 55" stroke="currentColor" strokeOpacity=".3" strokeWidth="2" /></svg><span className="signal-label">OBSERVE → QUESTION → VALIDATE</span></div>
    </section>
    <section className="stat-grid overview-metrics" aria-label="Workspace summary">
      <article className="stat-card"><span><Database size={15} /> Datasets</span><strong>{catalog.monitors.length}</strong><p>Available in this workspace</p></article>
      <article className="stat-card"><span><FileSpreadsheet size={15} /> Observations</span><strong>{catalog.total_rows.toLocaleString()}</strong><p>Source rows indexed</p></article>
      <article className="stat-card"><span><Activity size={15} /> Measurements</span><strong>{new Set(catalog.monitors.flatMap(item => item.metrics)).size}</strong><p>Configured time-series metrics</p></article>
      <article className="stat-card"><span><ShieldCheck size={15} /> Quality review</span><strong>{catalog.invalid_rows.toLocaleString()}</strong><p>Flagged timestamp rows</p></article>
    </section>
    <section className="workspace-paths" aria-label="Choose an analysis">
      {[
        { view: 'series' as const, icon: ChartNoAxesCombined, label: 'Time series', text: 'Follow trends, compare measurements, and explore changes over time.', tag: 'Explore patterns' },
        { view: 'statistics' as const, icon: Sigma, label: 'Statistical analysis', text: 'Profile columns, examine distributions, and test your hypotheses.', tag: 'Evaluate evidence' },
        { view: 'collocation' as const, icon: FlaskConical, label: 'Sensor collocation', text: 'Assess agreement, validate corrections, and track sensor drift.', tag: 'Validate instruments' },
      ].map(({ view, icon: Icon, label, text, tag }) => <button key={view} className="workspace-path" onClick={() => onNavigate(view)}><span className="path-icon"><Icon size={21} /></span><span className="path-tag">{tag}</span><h2>{label}</h2><p>{text}</p><span className="path-link">Open workspace <ArrowRight size={15} /></span></button>)}
    </section>
    <section className="details-card dataset-library">
      <div className="card-heading"><div><h2>Dataset library <span className="count-badge">{catalog.monitors.length}</span></h2><p>Your source files, ready to explore.</p></div><div className="library-search"><Search size={16} /><input aria-label="Search datasets" value={search} placeholder="Search datasets…" onChange={event => { setSearch(event.target.value); setLimit(12) }} />{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</div></div>
      {datasets.length ? <><div className="table-wrap"><table><thead><tr><th>Dataset</th><th>Observations</th><th>Date range</th><th>Timestamp flags</th><th>Action</th></tr></thead><tbody>{datasets.slice(0, limit).map(item => <tr key={item.id}><td><div className="dataset-name"><span className="dataset-icon"><FileSpreadsheet size={18} /></span><div><strong>{item.name}</strong><small>{item.filename}</small></div></div></td><td data-label="Observations">{item.rows.toLocaleString()}</td><td data-label="Date range">{item.start && item.end ? `${item.start.slice(0, 10)} → ${item.end.slice(0, 10)}` : 'No time mapping'}</td><td data-label="Timestamp review"><span className={`quality-badge ${item.invalid_rows ? 'review' : ''}`}>{item.invalid_rows ? `${item.invalid_rows.toLocaleString()} flagged` : item.start ? 'None flagged' : 'Not mapped'}</span></td><td><button className="library-action" onClick={() => onDataset(item.id)} aria-label={`Analyze ${item.name}`}>Analyze <ArrowRight size={14} /></button></td></tr>)}</tbody></table></div>{datasets.length > limit && <button className="library-more" onClick={() => setLimit(limit + 12)}>Show more datasets ({datasets.length - limit} remaining)</button>}</> : <div className="library-empty"><Database size={28} /><h3>{search ? 'No matching datasets' : 'Your next discovery starts here'}</h3><p>{search ? 'Try a different name or filename.' : 'Import a CSV, spreadsheet, or JSON file to begin your analysis.'}</p><button className="button secondary" onClick={search ? () => setSearch('') : onImport}>{search ? 'Clear search' : 'Import your first dataset'}</button></div>}
    </section>
    <div className="research-principle"><ShieldCheck size={17} /><p><strong>Transparent by design.</strong> Original files stay unchanged. Statistical results expose sample sizes, assumptions, and effect sizes. Automated guidance is rule-based, with no external AI service connected.</p></div>
  </>
}
