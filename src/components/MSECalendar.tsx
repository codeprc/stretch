import { useEffect, useRef, useState, type DragEvent } from 'react'
import { createMSESubtask, deleteMSESubtask, scheduleMSEItem, setMSESubtaskCompleted, setMSETaskCompleted, softDeleteMSECalendarItem, updateMSESubtask, updateMSETask, updateMSECalendarNotes, updatePlaygroundTask } from '../firebase'
import type { MSESkill, MSESubtask, MSETask } from '../firebase'
import { COUNTDOWN_STORAGE_KEY, COUNTDOWN_SYNC_EVENT } from '../completionEffects'
import { FormattedText } from './FormattedText'

export const MSE_SCHEDULE_DRAG_TYPE = 'application/x-mse-schedule-item'
export { COUNTDOWN_STORAGE_KEY, COUNTDOWN_SYNC_EVENT } from '../completionEffects'

interface MSECalendarProps {
  tasks: MSETask[]
  subtasks: MSESubtask[]
  skills: MSESkill[]
  compact?: boolean
  openRequest?: { key: string; token: number } | null
  onOpenRequestHandled?: () => void
}

interface ScheduledItem {
  id: string
  type: 'task' | 'subtask'
  title: string
  skill: string
  date: string
  order: number
  startTime: string
  durationMinutes: number
  notes: string
  completedOn: string | null
}

export interface CountdownTimer {
  deadline: number | null
  remainingSeconds: number
  totalSeconds: number
  updatedAt?: number
}

type ScheduleView = 'day' | 'week' | 'three-day'
type TimeDisplayUnit = 'hours' | 'minutes' | 'seconds'

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const FIRST_HOUR = 5
const LAST_HOUR = 23
const HOUR_HEIGHT = 120
const DRAG_SNAP_MINUTES = 1
const DURATION_OPTIONS = [...Array.from({ length: 10 }, (_, index) => 15 + index * 5), 75, 90, 120]
const TIME_RANGE_PATTERN = /^\s*(\d{1,2}):([0-5]\d)\s*(AM|PM)\s*-\s*(\d{1,2}):([0-5]\d)\s*(AM|PM)\s*$/i
export const loadCountdownTimers = (): Record<string, CountdownTimer> => {
  try {
    return typeof window === 'undefined' ? {} : JSON.parse(window.localStorage.getItem(COUNTDOWN_STORAGE_KEY) || '{}') as Record<string, CountdownTimer>
  } catch {
    return {}
  }
}
const scheduleHours = Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, index) => FIRST_HOUR + index)
const getWeekStart = (date: Date) => {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  start.setDate(start.getDate() - start.getDay())
  return start
}
const formatHour = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`
const formatStartTime = (value: string) => {
  const [rawHour, minute = '00'] = value.split(':')
  const hour = Number(rawHour)
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`
}
const formatEndTime = (value: string, durationMinutes: number) => {
  const [rawHour, rawMinute = '00'] = value.split(':')
  const endMinutes = (Number(rawHour) * 60 + Number(rawMinute) + durationMinutes) % (24 * 60)
  const hour = Math.floor(endMinutes / 60)
  const minute = String(endMinutes % 60).padStart(2, '0')
  return formatStartTime(`${String(hour).padStart(2, '0')}:${minute}`)
}
const formatMinutes = (minutes: number, unit: TimeDisplayUnit) => {
  if (unit === 'seconds') return `${Math.round(minutes * 60)}s`
  if (unit === 'minutes') return `${Math.round(minutes)}m`
  return `${Math.round(minutes / 60)}h`
}

export const persistCountdownTimers = (timers: Record<string, CountdownTimer>) => {
  try { window.localStorage.setItem(COUNTDOWN_STORAGE_KEY, JSON.stringify(timers)) } catch {}
  window.dispatchEvent(new Event(COUNTDOWN_SYNC_EVENT))
}
export const toggleStoredCountdown = (key: string, totalSeconds: number) => {
  const now = Date.now()
  const timers = loadCountdownTimers()
  const saved = timers[key]
  const current = saved?.totalSeconds === totalSeconds
    ? saved
    : { deadline: null, remainingSeconds: totalSeconds, totalSeconds }
  const alreadyRunning = Boolean(current.deadline && current.deadline > now)
  const otherRunningCount = Object.entries(timers).filter(([timerKey, timer]) => timerKey !== key && timer.deadline !== null && timer.deadline > now).length
  if (!alreadyRunning && otherRunningCount >= 2) return false
  const remainingSeconds = current.deadline
    ? Math.max(0, Math.ceil((current.deadline - now) / 1000))
    : current.remainingSeconds
  const next = current.deadline && current.deadline > now
    ? { ...current, deadline: null, remainingSeconds, updatedAt: now }
    : { ...current, deadline: now + (remainingSeconds || totalSeconds) * 1000, remainingSeconds: remainingSeconds || totalSeconds, updatedAt: now }
  persistCountdownTimers({ ...timers, [key]: next })
  return true
}
export const resetStoredCountdown = (key: string, totalSeconds: number) => {
  const timers = loadCountdownTimers()
  persistCountdownTimers({ ...timers, [key]: { deadline: null, remainingSeconds: totalSeconds, totalSeconds, updatedAt: Date.now() } })
}
export const removeStoredCountdown = (key: string) => {
  const timers = loadCountdownTimers()
  delete timers[key]
  persistCountdownTimers(timers)
}
export function MSECalendar({ tasks, subtasks, skills, compact = false, openRequest = null, onOpenRequestHandled }: MSECalendarProps) {
  const [todayKey] = useState(() => dateKey(new Date()))
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const [viewMonth, setViewMonth] = useState(() => {
    const today = new Date()
    return new Date(today.getFullYear(), today.getMonth(), 1)
  })
  const [scheduleView, setScheduleView] = useState<ScheduleView>('day')
  const [timeDisplayUnit, setTimeDisplayUnit] = useState<TimeDisplayUnit>('minutes')
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = new Date()
    return new Date(today.getFullYear(), today.getMonth(), today.getDate())
  })
  const [saveError, setSaveError] = useState('')
  const [savingDate, setSavingDate] = useState('')
  const [selectedItem, setSelectedItem] = useState<ScheduledItem | null>(null)
  const [editingTimeRange, setEditingTimeRange] = useState(false)
  const [timeRangeDraft, setTimeRangeDraft] = useState('')
  const [durationDraft, setDurationDraft] = useState('')
  const [itemTitleDraft, setItemTitleDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState('')
  const [newSubtaskDraft, setNewSubtaskDraft] = useState('')
  const [subtaskDrafts, setSubtaskDrafts] = useState<Record<string, string>>({})
  const [resizeState, setResizeState] = useState<{ key: string; pointerId: number; startY: number; startDuration: number; duration: number } | null>(null)
  const [countdownTimers, setCountdownTimers] = useState<Record<string, CountdownTimer>>(loadCountdownTimers)
  const handledOpenRequestRef = useRef<number | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    const syncTimers = () => setCountdownTimers(loadCountdownTimers())
    window.addEventListener(COUNTDOWN_SYNC_EVENT, syncTimers)
    window.addEventListener('storage', syncTimers)
    return () => {
      window.removeEventListener(COUNTDOWN_SYNC_EVENT, syncTimers)
      window.removeEventListener('storage', syncTimers)
    }
  }, [])
  const year = viewMonth.getFullYear()
  const month = viewMonth.getMonth()
  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const dayCount = new Date(year, month + 1, 0).getDate()
  const monthDays: (Date | null)[] = [
    ...Array.from({ length: new Date(year, month, 1).getDay() }, () => null),
    ...Array.from({ length: dayCount }, (_, index) => new Date(year, month, index + 1)),
  ]
  const rangeStart = scheduleView === 'week'
    ? getWeekStart(selectedDate)
    : new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + (scheduleView === 'three-day' ? -1 : 0))
  const visibleDates = Array.from({ length: scheduleView === 'week' ? 7 : scheduleView === 'three-day' ? 3 : 1 }, (_, index) => {
    const date = new Date(rangeStart)
    date.setDate(rangeStart.getDate() + index)
    return date
  })
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const skillNameForTask = (task: MSETask) => skills.find((skill) => skill.id === task.skill || skill.skill === task.skill)?.skill || ''
  const scheduledItems: ScheduledItem[] = [
    ...tasks.filter((task) => !task.deletedOn && task.scheduledOn).map((task) => ({
      id: task.id,
      type: 'task' as const,
      title: task.task,
      skill: skillNameForTask(task),
      date: (task.scheduledOn as string).slice(0, 10),
      order: task.scheduleOrder ?? 0,
      startTime: task.scheduledStartTime || '',
      durationMinutes: task.scheduledDurationMinutes ?? 25,
      notes: task.scheduledNotes,
      completedOn: task.completedOn,
    })),
    ...subtasks.filter((subtask) => !subtask.deletedOn && subtask.scheduledOn && taskById.has(subtask.taskId)).map((subtask) => {
      const parentTask = taskById.get(subtask.taskId) as MSETask
      return {
        id: subtask.id,
        type: 'subtask' as const,
        title: subtask.subtask,
        skill: skillNameForTask(parentTask),
        date: (subtask.scheduledOn as string).slice(0, 10),
        order: subtask.scheduleOrder ?? 0,
        startTime: subtask.scheduledStartTime || '',
        durationMinutes: subtask.scheduledDurationMinutes ?? 25,
        notes: subtask.scheduledNotes,
        completedOn: subtask.completedOn,
      }
    }),
  ].sort((first, second) => first.order - second.order || first.startTime.localeCompare(second.startTime))
  const itemsByDate = new Map<string, ScheduledItem[]>()
  scheduledItems.forEach((item) => itemsByDate.set(item.date, [...(itemsByDate.get(item.date) || []), item]))
  const selectedSubtask = selectedItem?.type === 'subtask' ? subtasks.find((subtask) => subtask.id === selectedItem.id) : undefined
  const selectedTask = selectedItem?.type === 'task'
    ? tasks.find((task) => task.id === selectedItem.id)
    : selectedSubtask ? tasks.find((task) => task.id === selectedSubtask.taskId) : undefined
  const selectedSubtasks = selectedTask ? subtasks.filter((subtask) => subtask.taskId === selectedTask.id && !subtask.deletedOn) : []

  const shiftMonth = (amount: number) => setViewMonth(new Date(year, month + amount, 1))
  const shiftRange = (amount: number) => setSelectedDate((current) => {
    const date = new Date(current)
    date.setDate(date.getDate() + amount * (scheduleView === 'week' ? 7 : 1))
    return date
  })
  const returnToToday = () => {
    const today = new Date()
    setSelectedDate(new Date(today.getFullYear(), today.getMonth(), today.getDate()))
  }

  const handleDrop = async (event: DragEvent<HTMLElement>, date: Date, targetOrder?: number) => {
    event.preventDefault()
    event.stopPropagation()
    const raw = event.dataTransfer.getData(MSE_SCHEDULE_DRAG_TYPE)
    if (!raw) return
    try {
      const payload: unknown = JSON.parse(raw)
      if (typeof payload !== 'object' || payload === null || !('id' in payload) || typeof payload.id !== 'string' || !('type' in payload) || (payload.type !== 'task' && payload.type !== 'subtask')) return
      const key = dateKey(date)
      setSavingDate(key)
      setSaveError('')
      await scheduleMSEItem(payload.type, payload.id, key, targetOrder)
      window.dispatchEvent(new Event('mse-panel-sync'))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not schedule item. Try again.')
    } finally {
      setSavingDate('')
    }
  }

  const changeDuration = async (item: ScheduledItem, durationMinutes: number) => {
    setSavingDate(item.date)
    setSaveError('')
    try {
      await scheduleMSEItem(item.type, item.id, item.date, undefined, durationMinutes)
      resetCountdown(`${item.type}-${item.id}`, durationMinutes * 60)
      setSelectedItem((current) => current ? { ...current, durationMinutes } : null)
      setDurationDraft(String(durationMinutes))
      window.dispatchEvent(new Event('mse-panel-sync'))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not change item duration.')
    } finally {
      setSavingDate('')
    }
  }

  const storeCountdown = (key: string, timer: CountdownTimer) => {
    const updated = { ...countdownTimers, ...loadCountdownTimers(), [key]: { ...timer, updatedAt: Date.now() } }
    setCountdownTimers(updated)
    persistCountdownTimers(updated)
  }

  const resetCountdown = (key: string, totalSeconds: number) => {
    storeCountdown(key, { deadline: null, remainingSeconds: totalSeconds, totalSeconds })
  }

  const toggleCountdown = (key: string, durationMinutes: number) => {
    if (!toggleStoredCountdown(key, durationMinutes * 60)) {
      setSaveError('Only two countdowns can run at once. Pause one before starting another.')
      return
    }
    setSaveError('')
  }

  const markCalendarItemDone = async (item: ScheduledItem, completed: boolean) => {
    if (item.type === 'task') await setMSETaskCompleted(item.id, completed)
    else await setMSESubtaskCompleted(item.id, completed)
    window.dispatchEvent(new Event('mse-panel-sync'))
  }

  const moveCalendarItem = async (item: ScheduledItem, minuteDelta: number) => {
    const [hour = FIRST_HOUR, minute = 0] = item.startTime.split(':').map(Number)
    const currentMinute = hour * 60 + minute
    const latestStart = LAST_HOUR * 60 - item.durationMinutes
    const targetMinute = Math.max(FIRST_HOUR * 60, Math.min(latestStart, currentMinute + minuteDelta))
    setSavingDate(item.date)
    setSaveError('')
    try {
      await scheduleMSEItem(item.type, item.id, item.date, targetMinute)
      window.dispatchEvent(new Event('mse-panel-sync'))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not move calendar item.')
    } finally {
      setSavingDate('')
    }
  }

  const removeFromCalendar = async (item: ScheduledItem) => {
    setSavingDate(item.date)
    try {
      await softDeleteMSECalendarItem(item.type, item.id)
      window.dispatchEvent(new Event('mse-panel-sync'))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not remove item from calendar.')
    } finally { setSavingDate('') }
  }

  const openItemDetails = (item: ScheduledItem) => {
    setSelectedItem(item)
    setDurationDraft(String(item.durationMinutes))
    setTimeRangeDraft(`${formatStartTime(item.startTime || '05:00')} - ${formatEndTime(item.startTime || '05:00', item.durationMinutes)}`)
    setEditingTimeRange(false)
    setItemTitleDraft(item.title)
    setNotesDraft(item.notes)
    setNewSubtaskDraft('')
    setSubtaskDrafts({})
  }

  useEffect(() => {
    if (!openRequest || handledOpenRequestRef.current === openRequest.token) return
    const item = scheduledItems.find((scheduledItem) => `${scheduledItem.type}-${scheduledItem.id}` === openRequest.key)
    if (!item) return
    handledOpenRequestRef.current = openRequest.token
    openItemDetails(item)
    onOpenRequestHandled?.()
  }, [openRequest, onOpenRequestHandled, scheduledItems])

  const saveItemTimeRange = async (rawRange = timeRangeDraft) => {
    if (!selectedItem) return
    const match = TIME_RANGE_PATTERN.exec(rawRange)
    if (!match) {
      setSaveError('Use the format 9:01 AM - 9:46 AM.')
      return
    }
    const toMinutes = (hourText: string, minuteText: string, periodText: string) => {
      const hour = Number(hourText)
      if (hour < 1 || hour > 12) return null
      return (hour % 12 + (periodText.toUpperCase() === 'PM' ? 12 : 0)) * 60 + Number(minuteText)
    }
    const startMinute = toMinutes(match[1], match[2], match[3])
    const endMinute = toMinutes(match[4], match[5], match[6])
    if (startMinute === null || endMinute === null || startMinute < FIRST_HOUR * 60 || endMinute > LAST_HOUR * 60 || endMinute <= startMinute) {
      setSaveError('Enter a valid range from 5 AM through 11 PM, with the end after the start.')
      return
    }
    const durationMinutes = endMinute - startMinute
    setSavingDate(selectedItem.date)
    setSaveError('')
    try {
      await scheduleMSEItem(selectedItem.type, selectedItem.id, selectedItem.date, startMinute, durationMinutes)
      const hour = Math.floor(startMinute / 60)
      const minute = startMinute % 60
      const formattedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      setSelectedItem((current) => current ? { ...current, startTime: formattedTime, durationMinutes } : null)
      setDurationDraft(String(durationMinutes))
      resetCountdown(`${selectedItem.type}-${selectedItem.id}`, durationMinutes * 60)
      setTimeRangeDraft(`${formatStartTime(formattedTime)} - ${formatEndTime(formattedTime, durationMinutes)}`)
      setEditingTimeRange(false)
      window.dispatchEvent(new Event('mse-panel-sync'))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not update scheduled time.')
    } finally {
      setSavingDate('')
    }
  }

  const saveItemTitle = async (rawText = itemTitleDraft) => {
    if (!selectedItem) return
    const text = rawText.trim()
    if (!text || text === selectedItem.title) return
    setSavingDate(selectedItem.date)
    try {
      if (selectedItem.type === 'task') await updateMSETask(selectedItem.id, text)
      else await updateMSESubtask(selectedItem.id, text)
      await updatePlaygroundTask(selectedItem.id, text)
      setSelectedItem((current) => current ? { ...current, title: text } : null)
      window.dispatchEvent(new Event('mse-panel-sync'))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not update item.')
    } finally { setSavingDate('') }
  }

  const saveItemNotes = async (text = notesDraft) => {
    if (!selectedItem) return
    setSavingDate(selectedItem.date)
    try {
      await updateMSECalendarNotes(selectedItem.type, selectedItem.id, text)
      setSelectedItem((current) => current ? { ...current, notes: text } : null)
      window.dispatchEvent(new Event('mse-panel-sync'))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save notes.')
    } finally { setSavingDate('') }
  }

  const addSelectedSubtask = async () => {
    const text = newSubtaskDraft.trim()
    if (!selectedTask || !text) return
    await createMSESubtask(selectedTask.id, text)
    setNewSubtaskDraft('')
    window.dispatchEvent(new Event('mse-panel-sync'))
  }

  const saveSubtaskTitle = async (subtask: MSESubtask, rawText = subtaskDrafts[subtask.id] ?? subtask.subtask) => {
    const text = rawText.trim()
    if (!text || text === subtask.subtask) return
    await updateMSESubtask(subtask.id, text)
    await updatePlaygroundTask(subtask.id, text)
    window.dispatchEvent(new Event('mse-panel-sync'))
  }

  const removeSelectedSubtask = async (subtask: MSESubtask) => {
    await deleteMSESubtask(subtask.id)
    window.dispatchEvent(new Event('mse-panel-sync'))
  }

  const toggleSelectedComplete = async () => {
    if (!selectedItem) return
    const isComplete = selectedItem.type === 'task' ? Boolean(selectedTask?.completedOn) : Boolean(selectedSubtask?.completedOn)
    if (selectedItem.type === 'task') await setMSETaskCompleted(selectedItem.id, !isComplete)
    else await setMSESubtaskCompleted(selectedItem.id, !isComplete)
    window.dispatchEvent(new Event('mse-panel-sync'))
  }

  const selectedTimerKey = selectedItem ? `${selectedItem.type}-${selectedItem.id}` : ''
  const selectedSavedTimer = selectedTimerKey ? countdownTimers[selectedTimerKey] : undefined
  const selectedTimer = selectedItem
    ? selectedSavedTimer?.totalSeconds === selectedItem.durationMinutes * 60
      ? selectedSavedTimer
      : { deadline: null, remainingSeconds: selectedItem.durationMinutes * 60, totalSeconds: selectedItem.durationMinutes * 60 }
    : null
  const selectedTimerRunning = Boolean(selectedTimer?.deadline && selectedTimer.deadline > currentTime)
  const selectedRemainingSeconds = selectedTimer?.deadline
    ? Math.max(0, Math.ceil((selectedTimer.deadline - currentTime) / 1000))
    : selectedTimer?.remainingSeconds ?? 0
  const selectedTimerDisplay = selectedTimerRunning
    ? `${Math.floor(selectedRemainingSeconds / 60)}:${String(selectedRemainingSeconds % 60).padStart(2, '0')}`
    : String(Math.ceil(selectedRemainingSeconds / 60))

  const itemDetailsDialog = selectedItem && <div className="mse-calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedItem(null) }}>
    <section className="mse-calendar-dialog" role="dialog" aria-modal="true" aria-labelledby="mse-calendar-dialog-title">
      <header><div><span>{selectedItem.type === 'task' ? 'Scheduled task' : 'Scheduled subtask'}</span><h2 id="mse-calendar-dialog-title">{selectedItem.title}</h2></div><button className="mse-calendar-dialog-close" type="button" aria-label="Close details" onClick={() => setSelectedItem(null)}>×</button></header>
      <label className="mse-calendar-done-checkbox"><input type="checkbox" checked={Boolean(selectedItem.type === 'task' ? selectedTask?.completedOn : selectedSubtask?.completedOn)} onChange={() => void toggleSelectedComplete()} /><span>Done</span></label>
      {selectedTask && <p className="mse-calendar-dialog-parent">Skill: {skills.find((skill) => skill.id === selectedTask.skill || skill.skill === selectedTask.skill)?.skill || skillNameForTask(selectedTask)}</p>}
      <div className="mse-calendar-dialog-time" onDoubleClick={() => { setTimeRangeDraft(`${formatStartTime(selectedItem.startTime)} - ${formatEndTime(selectedItem.startTime, selectedItem.durationMinutes)}`); setEditingTimeRange(true); setSaveError('') }} title="Double-click to edit the full time range">{editingTimeRange ? <input className="mse-calendar-time-range-input" autoFocus aria-label="Scheduled time range" value={timeRangeDraft} onChange={(event) => setTimeRangeDraft(event.target.value)} onBlur={(event) => void saveItemTimeRange(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setEditingTimeRange(false); setSaveError('') } }} /> : <span>{formatStartTime(selectedItem.startTime)} - {formatEndTime(selectedItem.startTime, selectedItem.durationMinutes)}</span>}<span>{selectedItem.durationMinutes}m</span></div>
      <div className="mse-calendar-dialog-countdown"><button type="button" aria-pressed={selectedTimerRunning} aria-label={`${selectedTimerRunning ? 'Pause' : 'Start'} countdown`} title={`${selectedTimerRunning ? 'Pause' : 'Start'} countdown`} onClick={() => toggleCountdown(selectedTimerKey, selectedItem.durationMinutes)}>{selectedTimerRunning ? 'Ⅱ' : '▶'}</button><output>{selectedTimerDisplay}/{Math.ceil((selectedTimer?.totalSeconds ?? 0) / 60)}m</output><button type="button" aria-label="Stop and remove countdown" title="Stop and remove countdown" onClick={() => removeStoredCountdown(selectedTimerKey)}>■</button></div>
      <label className="mse-calendar-dialog-duration">Duration<input type="number" min="1" max="1080" step="1" value={durationDraft} onChange={(event) => setDurationDraft(event.target.value)} onBlur={() => { const value = Number(durationDraft); if (Number.isInteger(value) && value >= 1 && value <= 1080) void changeDuration(selectedItem, value); else setDurationDraft(String(selectedItem.durationMinutes)) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
      <label className="mse-calendar-dialog-field">Task details<input value={itemTitleDraft} onChange={(event) => setItemTitleDraft(event.target.value)} onBlur={(event) => void saveItemTitle(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
      <label className="mse-calendar-dialog-field">Notes<textarea rows={4} value={notesDraft} onChange={(event) => setNotesDraft(event.target.value)} onBlur={(event) => void saveItemNotes(event.currentTarget.value)} placeholder="Write notes for this calendar item" /></label>
      {selectedTask && <section className="mse-calendar-dialog-subtasks"><h3>Subtasks</h3>
        {selectedSubtasks.map((subtask) => <div className="mse-calendar-dialog-subtask" key={subtask.id}><input type="checkbox" checked={Boolean(subtask.completedOn)} aria-label={`Mark ${subtask.subtask} complete`} onChange={() => void setMSESubtaskCompleted(subtask.id, !subtask.completedOn).then(() => window.dispatchEvent(new Event('mse-panel-sync')))} /><input value={subtaskDrafts[subtask.id] ?? subtask.subtask} aria-label="Subtask details" onChange={(event) => setSubtaskDrafts((current) => ({ ...current, [subtask.id]: event.target.value }))} onBlur={(event) => void saveSubtaskTitle(subtask, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /><button className="mse-calendar-dialog-remove" type="button" aria-label={`Remove subtask ${subtask.subtask}`} onClick={() => void removeSelectedSubtask(subtask)}>-</button></div>)}
        <div className="mse-calendar-dialog-add-subtask"><input value={newSubtaskDraft} placeholder="New subtask" aria-label="New subtask" onChange={(event) => setNewSubtaskDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addSelectedSubtask() }} /><button className="goal-manager-button" type="button" onClick={() => void addSelectedSubtask()}>+ Add subtask</button></div>
      </section>}
      <footer><button className="mse-calendar-dialog-remove" type="button" onClick={() => { void removeFromCalendar(selectedItem); setSelectedItem(null) }}>Remove from calendar</button></footer>
      {saveError && <p className="mse-calendar-status" role="status">{saveError}</p>}
    </section>
  </div>

  const renderCompactDay = (date: Date, index: number) => {
    const key = dateKey(date)
    const dateItems = itemsByDate.get(key) || []
    return <button
      className={`mse-calendar-day${key === todayKey ? ' today' : ''}${dateItems.length ? ' has-items' : ''}${savingDate === key ? ' saving' : ''}`}
      type="button"
      key={key || `compact-day-${index}`}
      aria-label={`${date.toLocaleDateString(undefined, { dateStyle: 'full' })}${dateItems.length ? `, ${dateItems.length} scheduled items` : ''}`}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
      onDrop={(event) => void handleDrop(event, date)}
    >
      <time dateTime={key}>{date.getDate()}</time>
      {dateItems.length > 0 && <span className="mse-calendar-marker" aria-hidden="true" />}
    </button>
  }

  const renderScheduleDay = (date: Date) => {
    const key = dateKey(date)
    const dateItems = itemsByDate.get(key) || []
    const topForItem = (startTime: string) => {
      const [hour = FIRST_HOUR, minute = 0] = startTime.split(':').map(Number)
      return ((hour - FIRST_HOUR) * 60 + minute) * HOUR_HEIGHT / 60
    }
    return <section
      className={`mse-schedule-day${key === todayKey ? ' today' : ''}${savingDate === key ? ' saving' : ''}`}
      key={key}
      aria-label={date.toLocaleDateString(undefined, { dateStyle: 'full' })}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
      onDrop={(event) => {
        const day = event.currentTarget.getBoundingClientRect()
        const minuteOffset = Math.max(0, event.clientY - day.top) * 60 / HOUR_HEIGHT
        const targetMinute = FIRST_HOUR * 60 + Math.round(minuteOffset / DRAG_SNAP_MINUTES) * DRAG_SNAP_MINUTES
        void handleDrop(event, date, targetMinute)
      }}
    >
      {dateItems.map((item) => {
        const itemKey = `${item.type}-${item.id}`
        const duration = resizeState?.key === itemKey ? resizeState.duration : item.durationMinutes
        const childSubtasks = item.type === 'task' ? subtasks.filter((subtask) => subtask.taskId === item.id && !subtask.deletedOn) : []
        const savedTimer = countdownTimers[itemKey]
        const timer = savedTimer?.totalSeconds === duration * 60
          ? savedTimer
          : { deadline: null, remainingSeconds: duration * 60, totalSeconds: duration * 60 }
        const isTimerRunning = Boolean(timer.deadline && timer.deadline > currentTime)
        const remainingSeconds = timer.deadline
          ? Math.max(0, Math.ceil((timer.deadline - currentTime) / 1000))
          : timer.remainingSeconds
        const timerDisplay = isTimerRunning
          ? `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`
          : String(Math.ceil(remainingSeconds / 60))
        return <span
          className={`mse-calendar-event ${item.type}${item.completedOn ? ' completed' : ''}`}
          key={itemKey}
          draggable
          tabIndex={0}
          aria-label={`${item.title}, scheduled ${formatStartTime(item.startTime)}, ${duration} minutes. Use Up or Down to move by one minute.`}
          onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest('button, select')) return
            event.preventDefault()
            event.stopPropagation()
            openItemDetails(item)
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return
            if (event.key === 'Enter') {
              event.preventDefault()
              openItemDetails(item)
              return
            }
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            void moveCalendarItem(item, event.key === 'ArrowUp' ? -1 : 1)
          }}
          style={{ top: topForItem(item.startTime), height: HOUR_HEIGHT * duration / 60 }}
          title={`Drag to move; drag the lower edge to resize. ${formatStartTime(item.startTime)} to ${formatEndTime(item.startTime, duration)}, ${item.title}`}
          onDragStart={(event) => {
            event.dataTransfer.setData(MSE_SCHEDULE_DRAG_TYPE, JSON.stringify({ type: item.type, id: item.id }))
            event.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={() => setSavingDate('')}
          onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move' }}
          onDrop={(event) => {
            const day = event.currentTarget.closest('.mse-schedule-day')?.getBoundingClientRect()
            const minuteOffset = day ? Math.max(0, event.clientY - day.top) * 60 / HOUR_HEIGHT : item.order * DRAG_SNAP_MINUTES
            const targetMinute = FIRST_HOUR * 60 + Math.round(minuteOffset / DRAG_SNAP_MINUTES) * DRAG_SNAP_MINUTES
            void handleDrop(event, date, targetMinute)
          }}
        >
          <input type="checkbox" className="mse-calendar-event-done" checked={Boolean(item.completedOn)} aria-label={`Mark ${item.title} ${item.completedOn ? 'not done' : 'done'}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onChange={(event) => void markCalendarItemDone(item, event.target.checked)} />
          <time>{formatStartTime(item.startTime)} - {formatEndTime(item.startTime, duration)}</time>
          <button className="mse-calendar-timer-toggle" type="button" aria-label={`${isTimerRunning ? 'Pause' : 'Start'} countdown for ${item.title}`} title={`${isTimerRunning ? 'Pause' : 'Start'} countdown`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); toggleCountdown(itemKey, duration) }}>{isTimerRunning ? 'Ⅱ' : '▶'} {timerDisplay}/{Math.ceil(timer.totalSeconds / 60)}m</button>
          <button className="mse-calendar-timer-stop" type="button" aria-label={`Stop and remove countdown for ${item.title}`} title="Stop and remove countdown" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeStoredCountdown(itemKey) }}>■</button>
          <span className="mse-calendar-event-content"><span><FormattedText text={item.title} /></span>{childSubtasks.map((subtask) => <small className="mse-calendar-subtask-preview" key={subtask.id}>{subtask.completedOn ? '✓ ' : '· '}<FormattedText text={subtask.subtask} /></small>)}</span>
          <input className="mse-calendar-duration-input" type="number" min="1" max="1080" step="1" aria-label={`Allocated minutes for ${item.title}`} title="Allocated minutes" defaultValue={duration} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onBlur={(event) => { const nextDuration = Number(event.currentTarget.value); if (Number.isInteger(nextDuration) && nextDuration >= 1 && nextDuration <= 1080) void changeDuration(item, nextDuration); else event.currentTarget.value = String(duration) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
          <button className="mse-calendar-remove" type="button" aria-label={`Remove ${item.title} from calendar`} title="Remove from calendar" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void removeFromCalendar(item) }}>-</button>
          <button
            className="mse-calendar-resize-handle"
            type="button"
            aria-label={`Resize ${item.title}`}
            title="Drag to stretch or shrink"
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.setPointerCapture(event.pointerId)
              setResizeState({ key: itemKey, pointerId: event.pointerId, startY: event.clientY, startDuration: duration, duration })
            }}
            onPointerMove={(event) => {
              if (!resizeState || resizeState.key !== itemKey || resizeState.pointerId !== event.pointerId) return
              const deltaMinutes = (event.clientY - resizeState.startY) * 60 / HOUR_HEIGHT
              const nextDuration = Math.max(1, Math.round(resizeState.startDuration + deltaMinutes))
              setResizeState((current) => current ? { ...current, duration: nextDuration } : null)
            }}
            onPointerUp={(event) => {
              if (!resizeState || resizeState.key !== itemKey || resizeState.pointerId !== event.pointerId) return
              const nextDuration = resizeState.duration
              setResizeState(null)
              if (nextDuration !== item.durationMinutes) void changeDuration(item, nextDuration)
            }}
            onPointerCancel={() => setResizeState(null)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              const currentOption = DURATION_OPTIONS.indexOf(item.durationMinutes)
              const nextIndex = Math.max(0, Math.min(DURATION_OPTIONS.length - 1, currentOption + (event.key === 'ArrowUp' ? 1 : -1)))
              const nextDuration = DURATION_OPTIONS[nextIndex] || item.durationMinutes
              void changeDuration(item, nextDuration)
            }}
          ><span aria-hidden="true" /></button>
        </span>
      })}
    </section>
  }

  if (!compact) {
    const rangeLabel = scheduleView === 'day'
      ? visibleDates[0].toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
      : `${visibleDates[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${visibleDates[visibleDates.length - 1].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
    return <section className={`mse-calendar large mode-${scheduleView}`} aria-label={`${scheduleView} schedule, ${rangeLabel}`}>
      <header className="mse-calendar-header">
        <h3>Schedule <span>{rangeLabel}</span></h3>
        <div className="mse-calendar-controls">
          <div className="mse-calendar-view-switch" role="group" aria-label="Schedule view">
            <button type="button" aria-pressed={scheduleView === 'day'} onClick={() => setScheduleView('day')}>Day</button>
            <button type="button" aria-pressed={scheduleView === 'week'} onClick={() => setScheduleView('week')}>Week</button>
            <button type="button" aria-label="Yesterday, today, and tomorrow" aria-pressed={scheduleView === 'three-day'} onClick={() => setScheduleView('three-day')}>Yday-Today-Tmoro</button>
          </div>
          <div className="mse-calendar-nav">
            <button type="button" aria-label={scheduleView === 'week' ? 'Previous week' : 'Previous day'} onClick={() => shiftRange(-1)}>&lt;</button>
            <button type="button" onClick={returnToToday}>Today</button>
            <button type="button" aria-label={scheduleView === 'week' ? 'Next week' : 'Next day'} onClick={() => shiftRange(1)}>&gt;</button>
          </div>
          <fieldset className="mse-time-unit-switch">
            <legend>Show time in</legend>
            {(['hours', 'minutes', 'seconds'] as const).map((unit) => <label key={unit}><input type="radio" name="schedule-time-unit" value={unit} checked={timeDisplayUnit === unit} onChange={() => setTimeDisplayUnit(unit)} />{unit}</label>)}
          </fieldset>
        </div>
      </header>
      <div className="mse-week-scroll">
        <div className="mse-week-header-grid">
          <span className="mse-week-corner" />
          {visibleDates.map((date) => {
            const dayItems = itemsByDate.get(dateKey(date)) || []
            const blockedMinutes = dayItems.reduce((total, item) => total + item.durationMinutes, 0)
            const isToday = dateKey(date) === todayKey
            const current = new Date(currentTime)
            const currentMinutes = current.getHours() * 60 + current.getMinutes() + current.getSeconds() / 60
            const availableMinutes = isToday ? Math.max(0, LAST_HOUR * 60 - currentMinutes) : (LAST_HOUR - FIRST_HOUR) * 60
            const futureBlockedMinutes = isToday ? dayItems.reduce((total, item) => {
              const [hour = FIRST_HOUR, minute = 0] = item.startTime.split(':').map(Number)
              return total + (hour * 60 + minute + item.durationMinutes > currentMinutes ? item.durationMinutes : 0)
            }, 0) : blockedMinutes
            const freeMinutes = Math.max(0, availableMinutes - futureBlockedMinutes)
            return <span className={`mse-week-day-heading${dateKey(date) === todayKey ? ' today' : ''}`} key={dateKey(date)}>
            <small>{date.toLocaleDateString(undefined, { weekday: 'short' })}</small>
            <time dateTime={dateKey(date)}>{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
            <em>{formatMinutes(blockedMinutes, timeDisplayUnit)} blocked · {formatMinutes(freeMinutes, timeDisplayUnit)} free</em>
          </span>})}
        </div>
        <div className="mse-week-body-grid">
          <div className="mse-week-time-axis">{scheduleHours.map((hour) => <span key={hour} style={{ height: HOUR_HEIGHT }}>{formatHour(hour)}</span>)}</div>
          {visibleDates.map(renderScheduleDay)}
        </div>
      </div>
      <p className="mse-calendar-status" role="status">{saveError || 'Drag tasks onto a day or time. Choose a duration on each event; overlaps move later events forward.'}</p>
      {itemDetailsDialog}
    </section>
  }

  return <section className="mse-calendar compact" aria-label={`${monthLabel} calendar`}>
    <header className="mse-calendar-header">
      <h3>{compact ? monthLabel : `Schedule · ${monthLabel}`}</h3>
      <div className="mse-calendar-nav">
        <button type="button" aria-label="Previous month" onClick={() => shiftMonth(-1)}>&lt;</button>
        <button type="button" aria-label="Next month" onClick={() => shiftMonth(1)}>&gt;</button>
      </div>
    </header>
    <div className="mse-calendar-grid mse-calendar-weekdays">{weekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}</div>
    <div className="mse-calendar-grid mse-calendar-days">{monthDays.map((date, index) => date ? renderCompactDay(date, index) : <span className="mse-calendar-empty" key={`empty-${index}`} aria-hidden="true" />)}</div>
    {itemDetailsDialog}
  </section>
}