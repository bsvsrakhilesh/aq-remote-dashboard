import { useEffect, useMemo, useRef } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { AriaComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import type { CollocationResult } from '../types'
import { CHART_COLORS } from './chartColors'

echarts.use([LineChart, AriaComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

export function CollocationChart({ result }: { result: CollocationResult }) {
  const element = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const option = useMemo<EChartsOption>(() => ({
    animationDuration: 450,
    color: CHART_COLORS,
    aria: { enabled: true },
    grid: { left: 48, right: 20, top: 40, bottom: 62 },
    legend: { type: 'scroll', top: 2, left: 0, itemWidth: 17, itemHeight: 3, textStyle: { color: '#59635e', fontSize: 11 } },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: '#17201c',
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 11 },
      valueFormatter: (value) => `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${result.study.unit}`,
    },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: '#dfe3e0' } }, axisTick: { show: false }, axisLabel: { color: '#78817d', fontSize: 10 } },
    yAxis: { type: 'value', scale: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#78817d', fontSize: 10 }, splitLine: { lineStyle: { color: '#edf0ee' } } },
    dataZoom: [
      { type: 'inside', filterMode: 'none', zoomOnMouseWheel: 'shift' },
      { type: 'slider', height: 20, bottom: 10, borderColor: 'transparent', backgroundColor: '#f1f4f2', fillerColor: 'rgba(23,107,82,.12)', handleStyle: { color: '#fff', borderColor: '#9daca5' }, textStyle: { color: 'transparent' } },
    ],
    series: [
      ...result.pairwise.sensors.filter((sensor) => sensor !== result.study.reference).map((sensor) => ({
        name: sensor,
        type: 'line' as const,
        showSymbol: false,
        data: result.series.map((point) => [point.timestamp, point.values[sensor]]),
        lineStyle: { width: 1.25, opacity: .72 },
        emphasis: { focus: 'series' as const, lineStyle: { width: 2.4, opacity: 1 } },
        connectNulls: false,
      })),
      {
        name: result.study.comparison_mode === 'reference' ? `Reference · ${result.study.reference}` : 'Fleet consensus',
        type: 'line' as const,
        showSymbol: false,
        data: result.series.map((point) => [point.timestamp, point.consensus]),
        lineStyle: { width: 3, color: '#17201c' },
        itemStyle: { color: '#17201c' },
        z: 10,
      },
    ],
  }), [result])

  useEffect(() => {
    if (!element.current) return
    chart.current = echarts.init(element.current)
    const observer = new ResizeObserver(() => chart.current?.resize())
    observer.observe(element.current)
    return () => { observer.disconnect(); chart.current?.dispose(); chart.current = null }
  }, [])

  useEffect(() => { chart.current?.setOption(option, { notMerge: true }) }, [option])
  return <div className="collocation-chart" ref={element} role="img" aria-label="Aligned sensor readings and fleet consensus" />
}
