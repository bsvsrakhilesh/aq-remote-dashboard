import { useEffect, useMemo, useRef } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import type { TimeSeriesResponse } from '../types'
import { CHART_COLORS } from './chartColors'

echarts.use([
  LineChart,
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
])

interface Props {
  data: TimeSeriesResponse | null
  loading: boolean
}

export function TimeSeriesChart({ data, loading }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  const option = useMemo<EChartsOption>(() => {
    const series = data?.series ?? []
    return {
      useUTC: true,
      animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: 450,
      color: CHART_COLORS,
      aria: { enabled: true },
      grid: { left: 56, right: 26, top: 30, bottom: 74, containLabel: false },
      legend: {
        type: 'scroll',
        top: 0,
        left: 0,
        itemWidth: 18,
        itemHeight: 3,
        icon: 'roundRect',
        textStyle: { color: '#4e5753', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12 },
      },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: '#18201d',
        borderWidth: 0,
        padding: [10, 12],
        textStyle: { color: '#f8faf9', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12 },
        axisPointer: { type: 'line', lineStyle: { color: '#8f9994', width: 1, type: 'dashed' } },
        valueFormatter: (value) => value == null ? 'No observation' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${data?.unit ?? ''}`,
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: '#dfe3e0' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#707974',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 11,
          hideOverlap: true,
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#707974', fontSize: 11 },
        splitLine: { lineStyle: { color: '#edf0ee', width: 1 } },
      },
      dataZoom: [
        { type: 'inside', filterMode: 'none', zoomOnMouseWheel: 'shift' },
        {
          type: 'slider',
          height: 24,
          bottom: 12,
          borderColor: 'transparent',
          backgroundColor: '#f2f4f2',
          fillerColor: 'rgba(23, 107, 82, 0.10)',
          dataBackground: {
            lineStyle: { color: '#94aaa2', width: 1 },
            areaStyle: { color: 'rgba(23, 107, 82, 0.08)' },
          },
          selectedDataBackground: {
            lineStyle: { color: '#176b52' },
            areaStyle: { color: 'rgba(23, 107, 82, 0.14)' },
          },
          handleStyle: { color: '#ffffff', borderColor: '#92a29c', borderWidth: 1 },
          moveHandleStyle: { color: '#85958f' },
          textStyle: { color: 'transparent' },
          brushSelect: true,
        },
      ],
      series: series.map((item) => ({
        name: item.monitor_name,
        type: 'line',
        data: item.points.map((point) => [point.timestamp, point.value]),
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 5,
        smooth: false,
        sampling: 'lttb',
        connectNulls: false,
        lineStyle: { width: 1.8 },
        emphasis: { focus: 'series', lineStyle: { width: 2.6 } },
      })),
    }
  }, [data])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(containerRef.current)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true })
  }, [option])

  useEffect(() => {
    if (loading) {
      chartRef.current?.showLoading('default', {
        text: '',
        color: '#176b52',
        maskColor: 'rgba(255,255,255,0.72)',
      })
    } else {
      chartRef.current?.hideLoading()
    }
  }, [loading])

  return <div className="chart-canvas" ref={containerRef} role="img" aria-label="Interactive time-series chart" />
}

export default TimeSeriesChart
