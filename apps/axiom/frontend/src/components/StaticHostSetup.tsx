import { ArrowUpRight, ChartNoAxesCombined, FlaskConical, Globe, Server, Sigma } from 'lucide-react'

const repository = 'https://github.com/bsvsrakhilesh/air-quality'

export default function StaticHostSetup() {
  return <div className="hosted-shell">
    <header className="hosted-header"><a className="brand" href={import.meta.env.BASE_URL}><span className="brand-mark"><Sigma size={22} /></span>Axiom</a><span><Globe size={15} /> Hosted on GitHub Pages</span></header>
    <main className="hosted-main">
      <div className="eyebrow">Research workspace</div>
      <h1>Your workspace is online.<br />Connect an analysis server to begin.</h1>
      <p className="hosted-intro">Axiom brings time series, statistics, and sensor validation into one workspace. The interface is published; the Python analysis server has not been connected yet.</p>
      <div className="workspace-paths hosted-features">
        <article className="workspace-path"><span className="path-icon"><ChartNoAxesCombined size={21} /></span><h2>Time series</h2><p>Explore patterns and compare measurements across datasets.</p><span className="path-link">Requires analysis server</span></article>
        <article className="workspace-path"><span className="path-icon"><Sigma size={21} /></span><h2>Statistical analysis</h2><p>Inspect distributions, correlations, and statistical evidence.</p><span className="path-link">Requires analysis server</span></article>
        <article className="workspace-path"><span className="path-icon"><FlaskConical size={21} /></span><h2>Sensor collocation</h2><p>Assess agreement, validate corrections, and track sensor drift.</p><span className="path-link">Requires analysis server</span></article>
      </div>
      <section className="hosted-setup" aria-labelledby="setup-heading">
        <span className="path-icon"><Server size={22} /></span><div><h2 id="setup-heading">Finish the connection</h2><p>GitHub Pages serves the frontend. Uploads, computations, and saved datasets require a separately hosted FastAPI server.</p>
          <ol><li>Deploy the backend to an HTTPS server with persistent storage and appropriate access controls.</li><li>Allow <code>{window.location.origin}</code> in the server’s <code>AXIOM_CORS_ORIGINS</code>.</li><li>Set the repository Actions variable <code>VITE_API_BASE_URL</code> to the server URL, without a trailing <code>/api</code>.</li><li>Run the <strong>Deploy GitHub Pages</strong> workflow again.</li></ol>
          <div className="heading-actions"><a className="button primary" href={`${repository}/blob/main/docs/github-pages.md`} target="_blank" rel="noreferrer">Deployment guide <ArrowUpRight size={15} /></a><a className="button secondary" href={repository} target="_blank" rel="noreferrer">View source <ArrowUpRight size={15} /></a></div>
        </div>
      </section>
      <p className="research-principle">No datasets are included in this deployment. Upload controls become available after the analysis server is configured.</p>
    </main>
  </div>
}
