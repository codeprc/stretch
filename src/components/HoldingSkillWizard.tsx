import { useEffect, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { CategoryScale, Chart as ChartJS, Filler, Legend, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js'
import type { ChartOptions } from 'chart.js'
import { endHoldingSkillRecording, fetchHoldingSkillData, startHoldingSkillRecording } from '../firebase'
import type { HoldingSkill, HoldingSkillRecording } from '../firebase'
import { FormattedText } from './FormattedText'

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Legend, Filler)

interface HoldingSkillWizardProps {
  theme: string
  onSkillsLoaded: (skills: HoldingSkill[]) => void
}

const formatDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return `${hours}h ${minutes}m ${remainder}s`
}

const recordingDuration = (recording: HoldingSkillRecording, now: number, span: HoldingSkill['span']) => {
  const start = new Date(recording.startTime).getTime()
  const end = recording.endTime ? new Date(recording.endTime).getTime() : now
  const divisor = ({
    second: 1000,
    minute: 60000,
    hour: 3600000,
    day: 86400000,
    week: 604800000,
    month: 2629746000,
    year: 31556952000,
  } satisfies Record<HoldingSkill['span'], number>)[span]
  return Number.isFinite(start) && Number.isFinite(end) ? Number(Math.max(0, end - start) / divisor).toFixed(2) : '0'
}

const spanLabels: Record<HoldingSkill['span'], { axis: string; plural: string }> = {
  second: { axis: 's', plural: 'Seconds' },
  minute: { axis: 'min', plural: 'Minutes' },
  hour: { axis: 'h', plural: 'Hours' },
  day: { axis: 'd', plural: 'Days' },
  week: { axis: 'wk', plural: 'Weeks' },
  month: { axis: 'mo', plural: 'Months' },
  year: { axis: 'yr', plural: 'Years' },
}

export function HoldingSkillWizard({ theme, onSkillsLoaded }: HoldingSkillWizardProps) {
  const [skills, setSkills] = useState<HoldingSkill[]>([])
  const [recordings, setRecordings] = useState<HoldingSkillRecording[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [message, setMessage] = useState('')

  const refresh = async () => {
    const result = await fetchHoldingSkillData()
    setSkills(result.skills)
    setRecordings(result.recordings)
    onSkillsLoaded(result.skills)
  }

  useEffect(() => {
    let mounted = true
    void fetchHoldingSkillData()
      .then((result) => {
        if (!mounted) return
        setSkills(result.skills)
        setRecordings(result.recordings)
        onSkillsLoaded(result.skills)
      })
      .catch((error: unknown) => {
        if (mounted) setMessage(`Unable to load skills: ${error instanceof Error ? error.message : 'Firestore request failed'}`)
      })
      .finally(() => { if (mounted) setLoading(false) })

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [onSkillsLoaded])

  const activeRecording = recordings.find((recording) => !recording.endTime)

  const handleStart = async (skill: HoldingSkill) => {
    if (saving || activeRecording) return
    setSaving(true)
    setMessage('')
    try {
      await startHoldingSkillRecording(skill.id)
      await refresh()
      setMessage(`Recording started for ${skill.skill}.`)
    } catch (error) {
      setMessage(`Could not start: ${error instanceof Error ? error.message : 'Firestore request failed'}`)
    } finally {
      setSaving(false)
    }
  }

  const handleEnd = async (recording: HoldingSkillRecording, skillName: string) => {
    if (saving) return
    setSaving(true)
    setMessage('')
    try {
      await endHoldingSkillRecording(recording.id)
      await refresh()
      setMessage(`Recording ended for ${skillName}.`)
    } catch (error) {
      setMessage(`Could not end: ${error instanceof Error ? error.message : 'Firestore request failed'}`)
    } finally {
      setSaving(false)
    }
  }

  const chartOptionsForSpan = (span: HoldingSkill['span']): ChartOptions<'line'> => {
    const { axis, plural } = spanLabels[span]
    return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => `${(context.parsed.y ?? 0).toFixed(2)} ${plural.toLowerCase()}` } } },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#9aa8b7', maxRotation: 0, autoSkip: true, font: { size: 9 } } },
      y: { beginAtZero: true, ticks: { color: '#9aa8b7', font: { size: 9 }, callback: (value) => `${value}${axis}` }, grid: { color: theme === 'dark' ? 'rgba(154, 168, 183, .14)' : 'rgba(99, 112, 108, .16)' } },
    },
    }
  }

  return <section className="group-wrapper holding-skill-wrapper" aria-label="Holding skill recorders">
    <div className="holding-skill-section-heading">
      <div className="widget-kicker">Duration practice / live log</div>
      <h2 className="widget-title">Holding skills</h2>
      <p className="holding-skill-message" aria-live="polite"><FormattedText text={message || (loading ? 'Loading skills...' : '')} /></p>
    </div>
    {!loading && !skills.length && <p className="holding-skill-message">No skills found in Holding_Myself_Long_Skills.</p>}
    <div className="holding-skill-list">
      {skills.map((skill) => {
        const skillRecordings = recordings.filter((recording) => recording.skillId === skill.id)
        const skillActiveRecording = skillRecordings.find((recording) => !recording.endTime)
        const otherActiveRecording = activeRecording && activeRecording.skillId !== skill.id ? activeRecording : null
        const activeSkillName = skills.find((item) => item.id === activeRecording?.skillId)?.skill || 'another skill'
        const chartData = {
          labels: skillRecordings.map((recording) => new Date(recording.startTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
          datasets: [{
            label: 'Duration',
            data: skillRecordings.map((recording) => Number(recordingDuration(recording, now, skill.span))),
            borderColor: '#4d9b78',
            backgroundColor: 'rgba(77, 155, 120, .14)',
            pointBackgroundColor: '#4d9b78',
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: .3,
            fill: true,
          }],
        }
        return <article className="widget metric-widget holding-skill-panel" id={`holding-skill-${skill.id}`} key={skill.id}>
          <div className="holding-skill-history">
            <div className="holding-skill-chart-heading"><span>Duration history</span><small>{spanLabels[skill.span].plural} per session</small></div>
            <div className="holding-skill-chart">
              {skillRecordings.length ? <Line data={chartData} options={chartOptionsForSpan(skill.span)} /> : <span>No recordings yet</span>}
            </div>
          </div>
          <div className="holding-skill-panel-controls">
            <div className="widget-kicker">{skillActiveRecording ? 'Recording in progress' : 'Ready to record'}</div>
            <h3 className="holding-skill-active-name"><FormattedText text={skill.skill} /></h3>
            {skillActiveRecording && <output className="holding-skill-clock">{formatDuration(now - new Date(skillActiveRecording.startTime).getTime())}</output>}
            <div className="holding-skill-actions">
              <button className="btn refresh-btn" disabled={loading || saving || Boolean(activeRecording)} onClick={() => void handleStart(skill)}>{saving ? 'Saving...' : 'Start recording'}</button>
              <button className="btn reset-btn" disabled={loading || saving || !skillActiveRecording} onClick={() => skillActiveRecording && void handleEnd(skillActiveRecording, skill.skill)}>{saving ? 'Saving...' : 'End recording'}</button>
            </div>
            <p className="holding-skill-panel-status"><FormattedText text={otherActiveRecording ? `End the active recording for ${activeSkillName} before starting this one.` : `${skillRecordings.length} recording${skillRecordings.length === 1 ? '' : 's'}`} /></p>
          </div>
        </article>
      })}
    </div>
  </section>
}
