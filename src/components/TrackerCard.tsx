import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchWidgetData, resetWidgetCounter, startStreakCounter, stopWidgetCounter, submitStreakCounter } from '../firebase'
import type { WidgetConfig } from '../firebase'

interface TrackerCardProps { config: WidgetConfig; theme: string }

const formatDuration = (milliseconds: number) => {
  if (!milliseconds || Number.isNaN(milliseconds) || milliseconds < 0) return '0s'
  const totalSeconds = Math.floor(milliseconds / 1000)
  const parts = []
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  parts.push(`${totalSeconds % 60}s`)
  return parts.join(' ')
}

const streakDays = (fromMs: number, tillMs?: number | null) => {
  const start = new Date(fromMs).setHours(0, 0, 0, 0)
  const end = new Date(tillMs ?? Date.now()).setHours(0, 0, 0, 0)
  return Math.max(1, Math.round((end - start) / 86400000) + 1)
}

export function TrackerCard({ config, theme: _theme }: TrackerCardProps) {
  const [displayValue, setDisplayValue] = useState('Loading...')
  const [started, setStarted] = useState('Started: --')
  const [updated, setUpdated] = useState('Last Updated: --')
  const [status, setStatus] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const timerRef = useRef<number | null>(null)

  const isLiveStrength = !config.isStreak

  const loadData = useCallback(async () => {
    if (timerRef.current) window.clearInterval(timerRef.current)
    setDisplayValue('Loading...')
    try {
      const result = await fetchWidgetData(config)
      setUpdated(result.maxLastUpdated ? `Last Updated: ${new Date(result.maxLastUpdated).toLocaleDateString()} ${new Date(result.maxLastUpdated).toLocaleTimeString()}` : 'Last Updated: --')
      if (!result.latestRecord) {
        setStarted('Started: --')
        setDisplayValue(config.isStreak ? '1 Day' : '--')
        setStatus('')
        return
      }
      setStarted(`Started: ${new Date(result.latestRecord.fromMs).toLocaleDateString()} ${new Date(result.latestRecord.fromMs).toLocaleTimeString()}`)
      if (config.isStreak) {
        const updateStreak = () => {
          const days = streakDays(result.latestRecord!.fromMs, result.latestRecord!.tillMs)
          setDisplayValue(`${days} Day${days === 1 ? '' : 's'}`)
        }
        updateStreak()
        if (!result.latestRecord.tillMs) timerRef.current = window.setInterval(updateStreak, 60000)
        setStatus(result.latestRecord.tillMs ? '○ Streak reset (wake target missed)' : '● Consistent streak active')
      } else if (!result.latestRecord.tillMs) {
        const updateLive = () => {
          const now = Date.now()
          setDisplayValue(formatDuration(now - result.latestRecord!.fromMs))
        }
        updateLive()
        timerRef.current = window.setInterval(updateLive, 1000)
        setStatus('● Counter running')
      } else {
        setDisplayValue(formatDuration(result.latestRecord.tillMs - result.latestRecord.fromMs))
        setStatus('○ Interval closed')
      }
    } catch (error) {
      setDisplayValue(`Error: ${error instanceof Error ? error.message : 'Unable to load data'}`)
    }
  }, [config])

  useEffect(() => {
    void loadData()
    return () => { if (timerRef.current) window.clearInterval(timerRef.current) }
  }, [loadData])

  const handleReset = async () => {
    setPending(true)
    setMessage(config.isStreak ? 'Breaking streak and restarting...' : 'Resetting counter...')
    try {
      await resetWidgetCounter(config)
      setMessage(config.isStreak ? 'Streak restarted: Day 1!' : 'Counter reset!')
      window.setTimeout(() => { setMessage(''); void loadData() }, 400)
    } catch (error) {
      setMessage(`Failed: ${error instanceof Error ? error.message : 'Unable to reset'}`)
    } finally { setPending(false) }
  }

  const handleStop = async () => {
    setPending(true)
    setMessage(`Stopping ${config.title.toLowerCase()} timer...`)
    try {
      await stopWidgetCounter(config)
      setMessage(`${config.title} saved!`)
      window.setTimeout(() => { setMessage(''); void loadData() }, 400)
    } catch (error) {
      setMessage(`Failed: ${error instanceof Error ? error.message : 'Unable to stop timer'}`)
    } finally { setPending(false) }
  }

  const handleStart = async () => {
    setPending(true)
    setMessage('Starting strength counter...')
    try {
      await startStreakCounter(config)
      setMessage('Strength counter started!')
      window.setTimeout(() => { setMessage(''); void loadData() }, 400)
    } catch (error) {
      setMessage(`Failed: ${error instanceof Error ? error.message : 'Unable to start counter'}`)
    } finally { setPending(false) }
  }

  const handleSubmit = async () => {
    setPending(true)
    setMessage('Submitting strength...')
    try {
      await submitStreakCounter(config)
      setMessage('Strength submitted!')
      window.setTimeout(() => { setMessage(''); void loadData() }, 400)
    } catch (error) {
      setMessage(`Failed: ${error instanceof Error ? error.message : 'Unable to submit strength'}`)
    } finally { setPending(false) }
  }

  return <section className="group-wrapper" style={{ '--accent-color': config.color } as React.CSSProperties}>
    <div className="widget metric-widget"><div className="widget-kicker">{config.id === 'hunger' ? 'Live belly tightness timer' : config.isStreak ? 'Consistency signal' : 'Live strength timer'}</div><h2 className="widget-title">{config.title}</h2><div className="pill-group"><span className="meta-pill">{started}</span><span className="meta-pill">{updated}</span></div><div className="widget-value">{displayValue}</div><div className="subtext">{status}</div><div className="btn-group"><button className="btn refresh-btn" disabled={pending} onClick={() => void loadData()}>Refresh Data</button>{(config.isStreak || isLiveStrength) && <button className="btn refresh-btn" disabled={pending || status === '● Counter running' || status === '● Consistent streak active'} onClick={() => void handleStart()}>Start Strength</button>}<button className="btn reset-btn" disabled={pending} onClick={() => void (config.isStreak ? handleSubmit() : isLiveStrength ? handleStop() : handleReset())}>{config.isStreak ? 'Submit Strength' : 'Stop Timer'}</button></div><div className="status-msg">{message}</div></div>
  </section>
}