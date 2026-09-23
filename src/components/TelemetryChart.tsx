import { Area, AreaChart, Brush, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Reading } from '../types'
import { format } from 'date-fns'

type ReadingKey = 'pm25' | 'pm10' | 'temperature' | 'rh' | 'co2'
export function TelemetryChart({
  title,
  unit,
  data,
  dataKey,
  color,
  decimals = 1,
}: {
  title: string
  unit: string
  data: Reading[]
  dataKey: ReadingKey
  color: string
  decimals?: number
}) {
  const values = data.map((d) => d[dataKey]).filter((v): v is number => v !== null)
  const stats = values.length
    ? {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        latest: values.at(-1)!,
      }
    : null
  const chartData = data.map((point) => ({ ...point, time: new Date(point.timestamp).getTime() }))
  const spansMultipleDays = chartData.length > 1 && chartData[chartData.length - 1].time - chartData[0].time > 86400000
  const gradientId = `gradient-${dataKey}`
  return (
    <article className={`chart-card ${dataKey === 'co2' ? 'co2-chart' : ''}`} aria-label={`${title} history`}>
      <div className="chart-head">
        <div>
          <span className="eyebrow">Time series</span>
          <h3>{title}</h3>
        </div>
        {stats && (
          <span className="chart-latest">
            {stats.latest.toFixed(decimals)} <small>{unit}</small>
          </span>
        )}
      </div>
      {stats ? (
        <>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 12, bottom: data.length > 100 ? 8 : 0, left: -10 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="var(--line)" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v: number) => format(v, spansMultipleDays ? 'dd MMM' : 'HH:mm')}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={44}
                />
                <YAxis axisLine={false} tickLine={false} />
                <Tooltip
                  content={({ active, payload, label }) =>
                    active && payload?.length ? (
                      <div className="chart-tooltip">
                        <span>{format(Number(label), 'dd MMM · HH:mm')}</span>
                        <strong>
                          {Number(payload[0].value).toFixed(decimals)} {unit}
                        </strong>
                      </div>
                    ) : null
                  }
                />
                <Area
                  isAnimationActive={false}
                  type="monotone"
                  dataKey={dataKey}
                  connectNulls={false}
                  stroke={color}
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  activeDot={{ r: 4, strokeWidth: 2 }}
                />
                {data.length > 100 && (
                  <Brush
                    dataKey="time"
                    height={22}
                    travellerWidth={9}
                    stroke={color}
                    fill="var(--surface-2)"
                    tickFormatter={() => ''}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-stats">
            <span>
              Min <strong>{stats.min.toFixed(decimals)}</strong>
            </span>
            <span>
              Avg <strong>{stats.avg.toFixed(decimals)}</strong>
            </span>
            <span>
              Max <strong>{stats.max.toFixed(decimals)}</strong>
            </span>
          </div>
        </>
      ) : (
        <div className="empty-chart">No measurements for this period.</div>
      )}
    </article>
  )
}
