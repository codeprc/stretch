import { useEffect, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { CategoryScale, Chart as ChartJS, Filler, Legend, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js'
import type { ChartOptions } from 'chart.js'
import { createMSESubtask, createMSETask, createPlaygroundTask, deleteMSESubtask, deleteMSETask, fetchPlaygroundData, setMSESubtaskCompleted, setMSETaskCompleted, updateMSESkill, updateMSESkillSubtext, updateMSESubtask, updateMSETask, updatePlaygroundTask } from '../firebase'
import type { MSESkill, MSESubtask, MSETask } from '../firebase'
import { FormattedText } from './FormattedText'
import { queueTaskForDiagram } from '../diagramQueue'
import { MSECalendar, MSE_SCHEDULE_DRAG_TYPE } from './MSECalendar'

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Legend, Filler)

interface MSEPanelProps {
  skill: MSESkill
  tasks: MSETask[]
  subtasks: MSESubtask[]
  theme: string
}

const formatTimestamp = (value: string | null) => value ? new Date(value).toLocaleDateString() : ''

export function MSEPanel({ skill, tasks, subtasks, theme }: MSEPanelProps) {
  const [isMaximized, setIsMaximized] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [draft, setDraft] = useState('')
  const [subtaskDrafts, setSubtaskDrafts] = useState<Record<string, string>>({})
  const [detailsTaskId, setDetailsTaskId] = useState<string | null>(null)
  const [taskDraft, setTaskDraft] = useState('')
  const [editingSkill, setEditingSkill] = useState(false)
  const [skillDraft, setSkillDraft] = useState(skill.skill)
  const [editingSubtext, setEditingSubtext] = useState(false)
  const [subtextDraft, setSubtextDraft] = useState(skill.subtext)
  const [saving, setSaving] = useState(false)
  const activeTasks = tasks.filter((task) => !task.deletedOn)
  const detailsTask = tasks.find((task) => task.id === detailsTaskId)
  const activeTaskIds = new Set(activeTasks.map((task) => task.id))
  const activeSubtasks = subtasks.filter((subtask) => !subtask.deletedOn && activeTaskIds.has(subtask.taskId))
  const visibleTasks = showCompleted ? tasks.filter((task) => task.completedOn || !task.deletedOn) : tasks.filter((task) => !task.deletedOn && !task.completedOn)
  const visibleTaskIds = new Set(visibleTasks.map((task) => task.id))
  const skillSubtasks = subtasks.filter((subtask) => visibleTaskIds.has(subtask.taskId) && (showCompleted || (!subtask.deletedOn && !subtask.completedOn)))
  const completedCount = activeTasks.filter((task) => task.completedOn).length + activeSubtasks.filter((subtask) => subtask.completedOn).length
  const totalItems = activeTasks.length + activeSubtasks.length
  const progress = totalItems ? Math.round((completedCount / totalItems) * 100) : 0
  const completionDates = [
    ...tasks.filter((task) => !task.deletedOn).map((task) => task.completedOn),
    ...subtasks.filter((subtask) => !subtask.deletedOn && activeTaskIds.has(subtask.taskId)).map((subtask) => subtask.completedOn),
  ]
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const velocityDays = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today)
    day.setDate(today.getDate() - 6 + index)
    return day
  })
  const velocityCounts = velocityDays.map((day) => {
    const start = day.getTime()
    const end = start + 24 * 60 * 60 * 1000
    return completionDates.filter((value) => {
      if (!value) return false
      const time = new Date(value).getTime()
      return time >= start && time < end
    }).length
  })

  useEffect(() => {
    setDraft('')
    setSubtaskDrafts({})
  }, [skill.id])

  useEffect(() => {
    const loadScreamIds = async () => {
      const data = await fetchPlaygroundData()
      const addedTexts = new Set(data.tasks.map((task) => task.text))
      document.querySelectorAll<HTMLButtonElement>('.scream-add-button').forEach((button) => {
        const label = button.getAttribute('aria-label') || ''
        const text = label.replace(/^Add /, '').replace(/ to Scream$/, '')
        button.classList.toggle('added', addedTexts.has(text))
      })
    }
    void loadScreamIds()
    const handleSync = () => { void loadScreamIds() }
    window.addEventListener('mse-panel-sync', handleSync)
    return () => { window.removeEventListener('mse-panel-sync', handleSync) }
  }, [])

  const notifySync = () => window.dispatchEvent(new Event('mse-panel-sync'))

  const addTask = async () => {
    const text = draft.trim()
    if (!text || saving) return
    setSaving(true)
    try { await createMSETask(text, skill.id); setDraft(''); notifySync() } finally { setSaving(false) }
  }

  const addSubtask = async (taskId: string) => {
    const text = (subtaskDrafts[taskId] || '').trim()
    if (!text || saving) return
    setSaving(true)
    try { await createMSESubtask(taskId, text); setSubtaskDrafts((current) => ({ ...current, [taskId]: '' })); notifySync() } finally { setSaving(false) }
  }

  const toggleTask = async (task: MSETask) => {
    if (saving) return
    setSaving(true)
    try { await setMSETaskCompleted(task.id, !task.completedOn); notifySync() } finally { setSaving(false) }
  }

  const saveTask = async (task: MSETask) => {
    const text = taskDraft.trim()
    if (!text || text === task.task || saving) return
    setSaving(true)
    try { await updateMSETask(task.id, text); await updatePlaygroundTask(task.id, text); notifySync() } finally { setSaving(false) }
  }

  const saveSubtask = async (subtask: MSESubtask, text: string) => {
    const nextText = text.trim()
    if (!nextText || nextText === subtask.subtask || saving) return
    setSaving(true)
    try { await updateMSESubtask(subtask.id, nextText); notifySync() } finally { setSaving(false) }
  }

  const removeSubtask = async (subtask: MSESubtask) => {
    if (saving) return
    setSaving(true)
    try { await deleteMSESubtask(subtask.id); notifySync() } finally { setSaving(false) }
  }

  const saveSkill = async () => {
    const text = skillDraft.trim()
    setEditingSkill(false)
    if (!text || text === skill.skill || saving) return
    setSaving(true)
    try { await updateMSESkill(skill.id, skill.skill, text); notifySync() } finally { setSaving(false) }
  }

  const saveSkillSubtext = async () => {
    const text = subtextDraft.trim()
    if (text === skill.subtext || saving) return
    setSaving(true)
    try { await updateMSESkillSubtext(skill.id, text); notifySync() } finally { setSaving(false) }
  }

  const toggleSubtask = async (subtask: MSESubtask) => {
    if (saving) return
    setSaving(true)
    try { await setMSESubtaskCompleted(subtask.id, !subtask.completedOn); notifySync() } finally { setSaving(false) }
  }

  const removeTask = async (task: MSETask) => {
    if (saving) return
    setSaving(true)
    try { await deleteMSETask(task.id, !task.deletedOn); notifySync() } finally { setSaving(false) }
  }

  const addToScream = async (text: string, sourceId: string) => {
    if (saving) return
    setSaving(true)
    try {
      await createPlaygroundTask(text, sourceId)
      document.querySelectorAll<HTMLButtonElement>('.scream-add-button').forEach((button) => {
        if (button.getAttribute('aria-label') === `Add ${text} to Scream`) button.classList.add('added')
      })
      notifySync()
    } finally { setSaving(false) }
  }

  const sendToDiagram = (button: HTMLButtonElement, text: string) => {
    queueTaskForDiagram(text)
    button.classList.add('added')
  }

  const velocityData = {
    labels: velocityDays.map((day) => day.toLocaleDateString(undefined, { weekday: 'short' })),
    datasets: [{ label: 'Completed', data: velocityCounts, borderColor: '#4d9b78', backgroundColor: 'rgba(77, 155, 120, .15)', pointBackgroundColor: '#4d9b78', pointRadius: 3, pointHoverRadius: 5, tension: .35, fill: true }],
  }
  const velocityOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { intersect: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#9aa8b7', font: { size: 9 }, maxRotation: 0 } },
      y: { beginAtZero: true, ticks: { color: '#9aa8b7', precision: 0, stepSize: 1, font: { size: 9 } }, grid: { color: theme === 'dark' ? 'rgba(154, 168, 183, .14)' : 'rgba(99, 112, 108, .16)' } },
    },
  }

  return <article className={`mse-card${isMaximized ? ' maximized' : ''}`}>
    <div className="mse-card-header">{editingSkill ? <input className="mse-inline-input" autoFocus value={skillDraft} onChange={(event) => setSkillDraft(event.target.value)} onBlur={() => void saveSkill()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditingSkill(false) }} aria-label="Edit skill name" /> : <h1 className="mse-skill-heading" title="Double-click to edit" onDoubleClick={() => { if (!saving) { setSkillDraft(skill.skill); setEditingSkill(true) } }}><FormattedText text={skill.skill} /></h1>}{editingSubtext ? <input className="mse-skill-subtext-input" autoFocus value={subtextDraft} onChange={(event) => setSubtextDraft(event.target.value)} onBlur={() => { setEditingSubtext(false); void saveSkillSubtext() }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setSubtextDraft(skill.subtext); setEditingSubtext(false) } }} aria-label={`Subtext for ${skill.skill}`} /> : <p className="mse-skill-subtext" role="button" tabIndex={0} title="Double-click to edit" onDoubleClick={() => { if (!saving) { setSubtextDraft(skill.subtext); setEditingSubtext(true) } }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSubtextDraft(skill.subtext); setEditingSubtext(true) } }}><FormattedText text={subtextDraft || 'Add skill subtext'} /></p>}</div>
    <div className="mse-card-toolbar"><strong>{progress}%</strong><button className="maximize-toggle" type="button" aria-label={isMaximized ? 'Restore panel' : 'Maximize panel'} onClick={() => setIsMaximized((current) => !current)}>{isMaximized ? 'Restore' : 'Maximize'}</button></div>
    <div className="mse-panel-content">
      <div className="mse-todo-panel">
        <div className="mse-todo-heading"><span>Tasks</span><button className="deleted-toggle" type="button" onClick={() => setShowCompleted((current) => !current)}>{showCompleted ? 'Hide completed' : 'Show completed'}</button><span>{visibleTasks.length} tasks / {skillSubtasks.length} subtasks</span></div>
        <div className="mse-todo-list">{visibleTasks.map((task) => <div className={`mse-todo-tree${task.deletedOn ? ' deleted-item' : ''}`} key={task.id}><div className="mse-todo-row"><button className="scream-add-button drawio-add-button" type="button" aria-label={`Add ${task.task} to draw.io`} title="Send to draw.io" onClick={(event) => sendToDiagram(event.currentTarget, task.task)}>📐</button><button className="scream-add-button" type="button" aria-label={`Add ${task.task} to Scream`} title="Add to Scream" onClick={() => void addToScream(task.task, task.id)}>🧠</button><input type="checkbox" checked={Boolean(task.completedOn)} disabled={Boolean(task.deletedOn)} onChange={() => void toggleTask(task)} /><span className={task.completedOn ? 'completed' : ''} draggable={!task.deletedOn} title={task.deletedOn ? undefined : 'Double-click to edit or drag to schedule'} onDragStart={(event) => { if (task.deletedOn) return; event.dataTransfer.setData(MSE_SCHEDULE_DRAG_TYPE, JSON.stringify({ type: 'task', id: task.id })); event.dataTransfer.effectAllowed = 'move' }} onDoubleClick={() => { if (!task.deletedOn && !saving) { setTaskDraft(task.task); setDetailsTaskId(task.id) } }}><FormattedText text={task.task} /></span><small>{task.deletedOn ? `Deleted ${formatTimestamp(task.deletedOn)}` : formatTimestamp(task.completedOn)}</small><button className="delete-task-button" type="button" aria-label={`${task.deletedOn ? 'Restore' : 'Delete'} ${task.task}`} onClick={() => void removeTask(task)}>{task.deletedOn ? 'Restore' : 'Delete'}</button></div>{skillSubtasks.filter((subtask) => subtask.taskId === task.id).map((subtask) => <div className={`mse-subtodo-row${subtask.deletedOn ? ' deleted-item' : ''}`} key={subtask.id}><button className="scream-add-button drawio-add-button" type="button" aria-label={`Add ${subtask.subtask} to draw.io`} title="Send to draw.io" onClick={(event) => sendToDiagram(event.currentTarget, subtask.subtask)}>📐</button><button className="scream-add-button" type="button" aria-label={`Add ${subtask.subtask} to Scream`} title="Add to Scream" onClick={() => void addToScream(subtask.subtask, subtask.id)}>🧠</button><input type="checkbox" checked={Boolean(subtask.completedOn)} disabled={Boolean(subtask.deletedOn)} onChange={() => void toggleSubtask(subtask)} /><span className={subtask.completedOn ? 'completed' : ''} draggable={!subtask.deletedOn} title={subtask.deletedOn ? undefined : 'Drag to schedule'} onDragStart={(event) => { if (subtask.deletedOn) return; event.dataTransfer.setData(MSE_SCHEDULE_DRAG_TYPE, JSON.stringify({ type: 'subtask', id: subtask.id })); event.dataTransfer.effectAllowed = 'move' }}><FormattedText text={subtask.subtask} /></span><small>{subtask.deletedOn ? `Deleted ${formatTimestamp(subtask.deletedOn)}` : formatTimestamp(subtask.completedOn)}</small></div>)}{!task.deletedOn && <div className="mse-input-row mse-subtask-input-row"><input className="mse-inline-input" value={subtaskDrafts[task.id] || ''} placeholder="New subtask" onChange={(event) => setSubtaskDrafts((current) => ({ ...current, [task.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') void addSubtask(task.id) }} /><button className="input-plus-button" aria-label={`Add subtask to ${task.task}`} onClick={() => void addSubtask(task.id)}>+</button></div>}</div>)}{!visibleTasks.length && <p className="mse-empty-todo">Add the first task below.</p>}</div>
        <div className="mse-input-row"><input className="mse-todo-input" value={draft} placeholder="New task" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addTask() }} /><button className="input-plus-button mse-root-input-button" aria-label="Add task" onClick={() => void addTask()}>+</button></div>
        {detailsTask && <div className="mse-calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailsTaskId(null) }}><section className="mse-calendar-dialog" role="dialog" aria-modal="true" aria-labelledby={`mse-task-dialog-title-${detailsTask.id}`}><header><div><span>Task details</span><h2 id={`mse-task-dialog-title-${detailsTask.id}`}>{detailsTask.task}</h2></div><button className="mse-calendar-dialog-close" type="button" aria-label="Close details" onClick={() => setDetailsTaskId(null)}>×</button></header><label className="mse-calendar-dialog-field">Task name<input autoFocus value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveTask(detailsTask) }} /></label><label className="mse-calendar-done-checkbox"><input type="checkbox" checked={Boolean(detailsTask.completedOn)} onChange={() => void toggleTask(detailsTask)} /><span>Done</span></label><section className="mse-calendar-dialog-subtasks"><h3>Subtasks</h3>{subtasks.filter((subtask) => subtask.taskId === detailsTask.id && !subtask.deletedOn).map((subtask) => <div className="mse-calendar-dialog-subtask" key={subtask.id}><input type="checkbox" checked={Boolean(subtask.completedOn)} aria-label={`Mark ${subtask.subtask} complete`} onChange={() => void toggleSubtask(subtask)} /><input value={subtaskDrafts[subtask.id] ?? subtask.subtask} aria-label="Subtask details" onChange={(event) => setSubtaskDrafts((current) => ({ ...current, [subtask.id]: event.target.value }))} onBlur={(event) => { void saveSubtask(subtask, event.currentTarget.value); setSubtaskDrafts((current) => { const next = { ...current }; delete next[subtask.id]; return next }) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /><button className="mse-calendar-dialog-remove" type="button" aria-label={`Remove subtask ${subtask.subtask}`} onClick={() => void removeSubtask(subtask)}>-</button></div>)}<div className="mse-calendar-dialog-add-subtask"><input value={subtaskDrafts[detailsTask.id] || ''} placeholder="New subtask" aria-label="New subtask" onChange={(event) => setSubtaskDrafts((current) => ({ ...current, [detailsTask.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') void addSubtask(detailsTask.id) }} /><button className="goal-manager-button" type="button" onClick={() => void addSubtask(detailsTask.id)}>+ Add subtask</button></div></section><footer><button className="goal-manager-button" type="button" onClick={() => void saveTask(detailsTask)}>Save details</button></footer></section></div>}
      </div>
      <div className="mse-insights-panel">
        <section className="mse-velocity-panel">
          <h3 className="mse-insight-heading">Completion velocity <span>Last 7 days</span></h3>
          <div className="mse-velocity-chart"><Line data={velocityData} options={velocityOptions} /></div>
        </section>
        <MSECalendar tasks={tasks} subtasks={subtasks} skills={[skill]} compact />
      </div>
    </div>
  </article>
}
