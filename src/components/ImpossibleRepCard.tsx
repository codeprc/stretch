import { useEffect, useState } from 'react'
import { addDoc, collection } from 'firebase/firestore'
import { db, fetchImpossibleRepHistory } from '../firebase'

const getCurrentDate = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

interface ImpossibleRepCardProps { theme: string }

export function ImpossibleRepCard({ theme: _theme }: ImpossibleRepCardProps) {
  const [date] = useState(getCurrentDate)
  const [count, setCount] = useState('1')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const loadHistory = async () => {
    try {
      await fetchImpossibleRepHistory()
    } catch (error) {
      setMessage(`Failed: ${error instanceof Error ? error.message : 'Unable to load history'}`)
    }
  }

  useEffect(() => { void loadHistory() }, [])

  const handleSave = async () => {
    const parsedCount = Number.parseInt(count, 10)
    if (!Number.isInteger(parsedCount) || parsedCount < 1) {
      setCount('1')
      setMessage('Enter a rep count greater than 0.')
      return
    }

    setSaving(true)
    setMessage('')
    try {
      await addDoc(collection(db, 'gym_impossible_rep'), {
        gym_date: date,
        impossible_rep_max: parsedCount,
      })
      setMessage('Rep count saved.')
      await loadHistory()
    } catch (error) {
      setMessage(`Failed: ${error instanceof Error ? error.message : 'Unable to save count'}`)
    } finally {
      setSaving(false)
    }
  }

  return <section className="group-wrapper impossible-rep-wrapper" style={{ '--accent-color': '#cf765e' } as React.CSSProperties}>
    <div className="widget metric-widget impossible-rep-widget">
      <div className="widget-kicker">Single-session challenge</div>
      <h2 className="widget-title">Doing the impossible rep in one gym session</h2>
      <div className="impossible-rep-fields">
        <label className="metric-field">
          <span>Gym date</span>
          <input value={date} readOnly aria-label="Gym date" />
        </label>
        <label className="metric-field">
          <span>Impossible rep max</span>
          <input type="number" min="1" step="1" value={count} onChange={(event) => setCount(event.target.value)} onBlur={() => { if (!count || Number(count) < 1) setCount('1') }} aria-label="Impossible rep max" />
        </label>
      </div>
      <button className="btn save-btn" disabled={saving} onClick={() => void handleSave()}>{saving ? 'Saving...' : 'Save count'}</button>
      <div className="status-msg">{message}</div>
    </div>
  </section>
}