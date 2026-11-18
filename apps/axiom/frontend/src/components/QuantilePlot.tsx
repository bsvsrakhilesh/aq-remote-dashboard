interface Props { points: Array<[number, number]>; column: string }

export function QuantilePlot({ points, column }: Props) {
  const valid = points.filter(point => point.every(Number.isFinite))
  if (valid.length < 3) return null
  const xs = valid.map(point => point[0])
  const ys = valid.map(point => point[1])
  const xmin = Math.min(...xs), xmax = Math.max(...xs)
  const ymin = Math.min(...ys), ymax = Math.max(...ys)
  const x = (value: number) => 55 + (value - xmin) / (xmax - xmin || 1) * 475
  const y = (value: number) => 215 - (value - ymin) / (ymax - ymin || 1) * 185
  // Quartile reference line, robust to extremes; not a fitted regression.
  const lo = valid[Math.floor(valid.length * .25)]
  const hi = valid[Math.floor(valid.length * .75)]
  const slope = (hi[1] - lo[1]) / (hi[0] - lo[0] || 1)
  const reference = (value: number) => lo[1] + slope * (value - lo[0])
  return <article className="analysis-card qq-card">
    <div className="card-heading"><div><h2>Normal Q–Q plot</h2><p>Visual check of distribution shape · {valid.length} plotted observations</p></div></div>
    <svg viewBox="0 0 560 270" role="img" aria-label={`Normal quantile plot for ${column}. Departures from the quartile reference line suggest non-normal shape.`}>
      <defs><clipPath id="qq-clip"><rect x="55" y="25" width="475" height="195" /></clipPath></defs>
      {[0, .25, .5, .75, 1].map(t => <g key={t}><line x1="55" x2="530" y1={30 + t * 185} y2={30 + t * 185} stroke="#e6ebe7" /><text x="47" y={34 + t * 185} textAnchor="end" fill="#657569" fontSize="10">{(ymax - t * (ymax - ymin)).toLocaleString(undefined, { maximumSignificantDigits: 3 })}</text></g>)}
      <g clipPath="url(#qq-clip)"><line x1={x(xmin)} y1={y(reference(xmin))} x2={x(xmax)} y2={y(reference(xmax))} stroke="#b99964" strokeDasharray="5 4" />{valid.map(([a, b], i) => <circle key={i} cx={x(a)} cy={y(b)} r="2" fill="#176b52" opacity=".55" />)}</g>
      <text x="292" y="252" textAnchor="middle" fill="#657569" fontSize="11">Theoretical normal quantiles</text><text x="15" y="120" textAnchor="middle" transform="rotate(-90 15 120)" fill="#657569" fontSize="11">Observed values</text>
      <text x="55" y="231" fill="#657569" fontSize="10">{xmin.toFixed(1)}</text><text x="530" y="231" textAnchor="end" fill="#657569" fontSize="10">{xmax.toFixed(1)}</text>
    </svg>
    <p className="plain-note">The dashed line passes through the plotted quartiles. Curvature or tail departures warrant investigation; this is not a pass/fail test. At most 500 observations are shown.</p>
  </article>
}
