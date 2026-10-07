import { useEffect, useState } from 'react'
import { addDoc, collection } from 'firebase/firestore'
import { db, fetchWorkStudyHistory } from '../firebase'

const getSessionDetails = () => {
  const now = new Date()
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(now)
}

interface WorkStudyCardProps { theme: string }

export function WorkStudyCard({ theme: _theme }: WorkStudyCardProps) {
  const [sessionDateTime] = useState(getSessionDetails)
  const [minutes, setMinutes] = useState('1')
  const [location, setLocation] = useState('Home')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const loadHistory = async () => {
    try {
      await fetchWorkStudyHistory()
    } catch (error) {
      setMessage(`Failed: ${error instanceof Error ? error.message : 'Unable to load session history'}`)
    }
  }

  useEffect(() => { void loadHistory() }, [])

  const handleSave = async () => {
    const parsedMinutes = Number.parseInt(minutes, 10)
    if (!Number.isInteger(parsedMinutes) || parsedMinutes < 1) {
      setMinutes('1')
      setMessage('Enter a session longer than 0 minutes.')
      return
    }

    setSaving(true)
    setMessage('')
    try {
      await addDoc(collection(db, 'study_work_willpower_strength'), {
        session_date_time: new Date().toISOString(),
        session_minutes_stretched: parsedMinutes,
        location,
      })
      setMessage('Work & study session saved.')
      await loadHistory()
    } catch (error) {
      setMessage(`Failed: ${error instanceof Error ? error.message : 'Unable to save session'}`)
    } finally {
      setSaving(false)
    }
  }

  return <section className="group-wrapper session-wrapper" style={{ '--accent-color': '#8b78b8' } as React.CSSProperties}>
    <div className="widget metric-widget session-widget">
      <div className="widget-kicker">Focused session</div>
      <h2 className="widget-title">Work &amp; Study Willpower Strength</h2>
      <div className="impossible-rep-fields">
        <label className="metric-field">
          <span>Auto session day / hour</span>
          <input value={sessionDateTime} readOnly aria-label="Automatically populated session day and hour" />
        </label>
        <label className="metric-field">
          <span>Stretched minutes</span>
          <input type="number" min="1" step="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} onBlur={() => { if (!minutes || Number(minutes) < 1) setMinutes('1') }} aria-label="Session minutes stretched" />
        </label>
      </div>
      <fieldset className="location-options">
        <legend>Session location</legend>
        <label><input type="radio" name="work-study-location" value="Work" checked={location === 'Work'} onChange={(event) => setLocation(event.target.value)} /> At Work</label>
        <label><input type="radio" name="work-study-location" value="Home" checked={location === 'Home'} onChange={(event) => setLocation(event.target.value)} /> At Home</label>
      </fieldset>
      <button className="btn save-btn" disabled={saving} onClick={() => void handleSave()}>{saving ? 'Saving...' : 'Save session'}</button>
      <div className="status-msg">{message}</div>
    </div>
  </section>
}