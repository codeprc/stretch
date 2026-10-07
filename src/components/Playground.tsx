import { useEffect, useState, type DragEvent } from 'react'
import { createPlaygroundStream, createPlaygroundTask, fetchPlaygroundData, softDeletePlaygroundStream, softDeletePlaygroundTask, updatePlaygroundStreamBranches, updatePlaygroundStreamName, updatePlaygroundStreamScroll, updatePlaygroundStreamTasks, updatePlaygroundTask } from '../firebase'
import type { PlaygroundBranch, PlaygroundStream, PlaygroundTask } from '../firebase'
import { FormattedText } from './FormattedText'

const PLAYGROUND_DRAG_TYPE = 'application/x-playground-task'
const screamColors = ['#4d9b78', '#d9a441', '#4d899b', '#bd6b83', '#c47b54', '#5a7ba0']

export function Playground() {
  const [tasks, setTasks] = useState<PlaygroundTask[]>([])
  const [streams, setStreams] = useState<PlaygroundStream[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [linearStreams, setLinearStreams] = useState<Set<string>>(new Set())
  const [showRemovedStreams, setShowRemovedStreams] = useState<Set<string>>(new Set())
  const [editingStreamId, setEditingStreamId] = useState<string | null>(null)
  const [streamNameDraft, setStreamNameDraft] = useState('')
  const [editingArrowId, setEditingArrowId] = useState<string | null>(null)
  const [arrowTextDraft, setArrowTextDraft] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const data = await fetchPlaygroundData()
        if (!active) return
        setTasks(data.tasks)
        setStreams(data.streams)
      } catch { if (active) setMessage('Could not load Playground.') }
      finally { if (active) setLoading(false) }
    }
    void load()
    const handleSync = () => { void load() }
    const refreshTimer = window.setInterval(() => { void load() }, 2000)
    window.addEventListener('mse-panel-sync', handleSync)
    return () => { active = false; window.clearInterval(refreshTimer); window.removeEventListener('mse-panel-sync', handleSync) }
  }, [])

  const removeTask = async (task: PlaygroundTask) => {
    await softDeletePlaygroundTask(task.id)
    setTasks((current) => current.filter((item) => item.id !== task.id))
    setStreams((current) => current.map((stream) => ({ ...stream, taskIds: stream.taskIds.filter((id) => id !== task.id) })))
  }

  const addStream = async () => {
    const name = window.prompt('Name this Streamlining panel')?.trim()
    if (!name) return
    const created = await createPlaygroundStream(name)
    setStreams((current) => [...current, { id: created.id, name, taskIds: [], removedTaskIds: [], createdAt: new Date().toISOString(), scrollAfterFive: true, branches: [] }])
  }

  const removeStream = async (stream: PlaygroundStream) => {
    await softDeletePlaygroundStream(stream.id)
    setStreams((current) => current.filter((item) => item.id !== stream.id))
  }

  const saveStreamName = async (stream: PlaygroundStream, value: string) => {
    const name = value.trim()
    setEditingStreamId(null)
    if (!name || name === stream.name) return
    await updatePlaygroundStreamName(stream.id, name)
    setStreams((current) => current.map((item) => item.id === stream.id ? { ...item, name } : item))
  }

  const setStreamScrollAfterFive = async (stream: PlaygroundStream, scrollAfterFive: boolean) => {
    await updatePlaygroundStreamScroll(stream.id, scrollAfterFive)
    setStreams((current) => current.map((item) => item.id === stream.id ? { ...item, scrollAfterFive } : item))
  }

  const addStreamBranch = async (stream: PlaygroundStream, parentTask: PlaygroundTask, position: PlaygroundBranch['position'], parentBranchId?: string) => {
    const parentBranch = parentBranchId ? stream.branches.find((branch) => branch.id === parentBranchId) : undefined
    const text = window.prompt(parentBranch ? `Next step after ${parentBranch.text}` : `Alternative next step ${position === 'top' ? 'above' : 'below'} ${parentTask.text}`)?.trim()
    if (!text) return
    const branches = [...stream.branches, { id: crypto.randomUUID(), parentTaskId: parentTask.id, ...(parentBranchId ? { parentBranchId } : {}), position, text }]
    await updatePlaygroundStreamBranches(stream.id, branches)
    setStreams((current) => current.map((item) => item.id === stream.id ? { ...item, branches } : item))
  }

  const removeStreamBranch = async (stream: PlaygroundStream, branchId: string) => {
    const removedIds = new Set([branchId])
    let changed = true
    while (changed) {
      changed = false
      stream.branches.forEach((branch) => {
        if (branch.parentBranchId && removedIds.has(branch.parentBranchId) && !removedIds.has(branch.id)) {
          removedIds.add(branch.id)
          changed = true
        }
      })
    }
    const branches = stream.branches.filter((branch) => !removedIds.has(branch.id))
    await updatePlaygroundStreamBranches(stream.id, branches)
    setStreams((current) => current.map((item) => item.id === stream.id ? { ...item, branches } : item))
  }

  const saveStreamBranchText = async (stream: PlaygroundStream, branch: PlaygroundBranch, rawText: string) => {
    const text = rawText.trim()
    if (!text || text === branch.text) return
    const branches = stream.branches.map((item) => item.id === branch.id ? { ...item, text } : item)
    await updatePlaygroundStreamBranches(stream.id, branches)
    setStreams((current) => current.map((item) => item.id === stream.id ? { ...item, branches } : item))
  }

  const renderBranchOption = (stream: PlaygroundStream, branch: PlaygroundBranch) => <span className="streamlining-branch-option" key={branch.id}>
    <span title="Double-click to edit" onDoubleClick={(event) => { const input = event.currentTarget.nextElementSibling as HTMLInputElement | null; if (input) { input.value = branch.text; input.hidden = false; input.focus(); event.currentTarget.hidden = true } }}><FormattedText text={branch.text} /></span>
    <input hidden aria-label="Update branch text" defaultValue={branch.text} onBlur={(event) => { event.currentTarget.hidden = true; const label = event.currentTarget.previousElementSibling as HTMLElement | null; if (label) label.hidden = false; void saveStreamBranchText(stream, branch, event.currentTarget.value) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.value = branch.text; event.currentTarget.blur() } }} />
    <button type="button" aria-label={`Remove option ${branch.text}`} title="Remove option" onClick={() => void removeStreamBranch(stream, branch.id)}>×</button>
  </span>

  const renderBranchLane = (stream: PlaygroundStream, task: PlaygroundTask, root: PlaygroundBranch) => {
    const chain: PlaygroundBranch[] = []
    let current: PlaygroundBranch | undefined = root
    while (current && !chain.some((branch) => branch.id === current?.id)) {
      chain.push(current)
      current = stream.branches.find((branch) => branch.parentBranchId === current?.id)
    }
    const last = chain[chain.length - 1]
    return <span className="streamlining-branch-lane" key={root.id}>{chain.map((branch, index) => <span className="streamlining-branch-step" key={branch.id}>{index > 0 && <span className="streamlining-branch-connector" aria-hidden="true" />}{renderBranchOption(stream, branch)}</span>)}<button className="streamlining-lane-add" type="button" aria-label={`Add next step after ${last.text}`} title="Add next step" onClick={() => void addStreamBranch(stream, task, root.position, last.id)}>+</button></span>
  }

  const saveArrowText = async (task: PlaygroundTask, value = arrowTextDraft) => {
    const text = value.trim()
    setEditingArrowId(null)
    if (!text || text === task.text) return
    await updatePlaygroundTask(task.sourceTaskId, text)
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, text } : item))
  }

  const dropTask = async (event: DragEvent<HTMLElement>, stream: PlaygroundStream) => {
    event.preventDefault()
    const taskId = event.dataTransfer.getData(PLAYGROUND_DRAG_TYPE)
    if (!taskId || stream.taskIds.includes(taskId)) return
    const taskIds = [...stream.taskIds, taskId]
    await updatePlaygroundStreamTasks(stream.id, taskIds)
    setStreams((current) => current.map((item) => item.id === stream.id ? { ...item, taskIds } : item))
  }

  const reorderStreamTask = async (stream: PlaygroundStream, taskId: string, targetIndex: number) => {
    const sourceIndex = stream.taskIds.indexOf(taskId)
    if (sourceIndex < 0) return
    const next = [...stream.taskIds]
    next.splice(sourceIndex, 1)
    next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, taskId)
    await updatePlaygroundStreamTasks(stream.id, next)
    setStreams((current) => current.map((item) => item.id === stream.id ? { ...item, taskIds: next } : item))
  }

  const removeStreamTask = async (stream: PlaygroundStream, taskId: string) => {
    const taskIds = stream.taskIds.filter((id) => id !== taskId)
    const removedTaskIds = [...new Set([...stream.removedTaskIds, taskId])]
    await updatePlaygroundStreamTasks(stream.id, taskIds, removedTaskIds)
    setStreams((current) => current.map((item) => item.id === stream.id ? { ...item, taskIds, removedTaskIds } : item))
  }

  const restoreStreamTask = async (stream: PlaygroundStream, taskId: string) => {
    const taskIds = [...stream.taskIds, taskId]
    const removedTaskIds = stream.removedTaskIds.filter((id) => id !== taskId)
    await updatePlaygroundStreamTasks(stream.id, taskIds, removedTaskIds)
    setStreams((current) => current.map((item) => item.id === stream.id ? { ...item, taskIds, removedTaskIds } : item))
  }

  const addStreamTask = async (stream: PlaygroundStream, index: number) => {
    const text = window.prompt(index === 0 ? 'New arrow before this task' : 'New arrow after this task')?.trim()
    if (!text) return
    const created = await createPlaygroundTask(text, `stream-${crypto.randomUUID()}`)
    const task = { id: created.id, text, sourceTaskId: `stream-${created.id}`, createdAt: new Date().toISOString() }
    setTasks((current) => [...current, task])
    const taskIds = [...stream.taskIds]
    taskIds.splice(index, 0, task.id)
    await updatePlaygroundStreamTasks(stream.id, taskIds)
    setStreams((current) => current.map((item) => item.id === stream.id ? { ...item, taskIds } : item))
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]))

  return <section className="playground-page" aria-label="Playground">
    <header className="playground-heading"><div><p className="eyebrow">Experiment / task shaping</p><h2>Playground</h2></div><button className="goal-manager-button" type="button" onClick={() => void addStream()}>+ Create Streamlining</button></header>
    {message && <p className="holding-skill-message">{message}</p>}
    {loading ? <p className="playground-empty">Loading Playground...</p> : <>
      <section id="playground-scream" className="playground-surface scream-surface" aria-label="Scream">
        <div className="playground-surface-header"><div><span className="widget-kicker">Unsorted task field</span><h3>Scream</h3></div><span>{tasks.length} tasks</span></div>
        <div className="scream-board">{tasks.length ? tasks.map((task, index) => <article id={`playground-task-${task.id}`} className="scream-task" key={task.id} style={{ background: screamColors[index % screamColors.length], transform: `rotate(${(index % 3 - 1) * 1.2}deg)` }} draggable onDragStart={(event) => { event.dataTransfer.setData(PLAYGROUND_DRAG_TYPE, task.id); event.dataTransfer.effectAllowed = 'copy' }}><button className="playground-remove" type="button" aria-label={`Remove ${task.text}`} title="Remove from Playground" onClick={() => void removeTask(task)}>-</button><FormattedText text={task.text} /></article>) : <p className="playground-empty">New MSE tasks will appear here.</p>}</div>
      </section>
      <section id="playground-streamlining" className="playground-surface streamlining-surface" aria-label="Streamlining">
        <div className="playground-surface-header"><div><span className="widget-kicker">Ordered task chains</span><h3>Streamlining</h3></div><div className="playground-surface-actions"><button className="goal-manager-button" type="button" onClick={() => void addStream()}>+ Add Streamlining</button><span>{streams.length} panels</span></div></div>
        <div className="streamlining-list">{streams.length ? streams.map((stream) => {
          const visibleTasks = stream.taskIds.map((taskId) => taskById.get(taskId)).filter((task): task is PlaygroundTask => Boolean(task))
          const removedTasks = stream.removedTaskIds.map((taskId) => taskById.get(taskId)).filter((task): task is PlaygroundTask => Boolean(task))
          return <article id={`playground-stream-${stream.id}`} className={`streamlining-panel${linearStreams.has(stream.id) ? ' linear-layout' : ''}`} key={stream.id} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={(event) => void dropTask(event, stream)}>
            <div className="streamlining-panel-heading"><div className="streamlining-panel-leading"><button className="streamlining-panel-remove" type="button" aria-label={`Remove ${stream.name} panel`} title="Remove Streamlining panel" onClick={() => void removeStream(stream)}>-</button><button className="strategy-layout-toggle" type="button" aria-label={`Switch ${stream.name} layout`} aria-pressed={linearStreams.has(stream.id)} title="Toggle arrow or boxed row layout" onClick={() => setLinearStreams((current) => { const next = new Set(current); if (next.has(stream.id)) next.delete(stream.id); else next.add(stream.id); return next })}>▤</button><label className="streamlining-scroll-setting"><input type="checkbox" checked={stream.scrollAfterFive} aria-label={`Enable scrolling after five arrows in ${stream.name}`} onChange={(event) => void setStreamScrollAfterFive(stream, event.target.checked)} /><span>Scroll after 5</span></label>{editingStreamId === stream.id ? <input className="streamlining-name-input" autoFocus value={streamNameDraft} onChange={(event) => setStreamNameDraft(event.target.value)} onBlur={(event) => void saveStreamName(stream, event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setStreamNameDraft(stream.name); setEditingStreamId(null) } }} aria-label="Streamlining panel name" /> : <h4 title="Double-click to rename" onDoubleClick={() => { setStreamNameDraft(stream.name); setEditingStreamId(stream.id) }}>{stream.name}</h4>}</div><div className="streamlining-panel-controls">{removedTasks.length > 0 && <button className="goal-manager-button" type="button" aria-expanded={showRemovedStreams.has(stream.id)} onClick={() => setShowRemovedStreams((current) => { const next = new Set(current); if (next.has(stream.id)) next.delete(stream.id); else next.add(stream.id); return next })}>{showRemovedStreams.has(stream.id) ? 'Hide removed' : 'Show removed'}</button>}</div></div>
            <div className="streamlining-arrow-row"><div className={`streamlining-task-list${stream.scrollAfterFive && visibleTasks.length + stream.branches.length > 5 ? ' scroll-after-five' : ''}${linearStreams.has(stream.id) ? ' linear-layout' : ''}`}>{visibleTasks.map((task, index) => {
              const isEditingArrow = editingArrowId === task.id
              const topBranches = stream.branches.filter((branch) => branch.parentTaskId === task.id && branch.position === 'top' && !branch.parentBranchId)
              const bottomBranches = stream.branches.filter((branch) => branch.parentTaskId === task.id && branch.position === 'bottom' && !branch.parentBranchId)
              return <span className="streamlining-arrow-group" key={task.id}>
                <button className="streamlining-plus" type="button" aria-label={`Add before ${task.text}`} onClick={() => void addStreamTask(stream, index)}>+</button>
                <span className="streamlining-branch-stack">
                  <span className="streamlining-task" draggable={!isEditingArrow} onDragStart={(event) => { event.dataTransfer.setData(PLAYGROUND_DRAG_TYPE, task.id); event.dataTransfer.effectAllowed = 'move' }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void reorderStreamTask(stream, event.dataTransfer.getData(PLAYGROUND_DRAG_TYPE), index) }}>
                    {isEditingArrow ? <input className="streamlining-arrow-input" autoFocus value={arrowTextDraft} aria-label="Update arrow text" onChange={(event) => setArrowTextDraft(event.target.value)} onBlur={(event) => void saveArrowText(task, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setArrowTextDraft(task.text); setEditingArrowId(null) } }} /> : <span className="streamlining-task-text" title="Double-click to edit" onDoubleClick={(event) => { event.stopPropagation(); setArrowTextDraft(task.text); setEditingArrowId(task.id) }}><FormattedText text={task.text} /></span>}
                    <button className="streamlining-remove" type="button" aria-label={`Remove ${task.text} from ${stream.name}`} title="Remove from Streamlining" onClick={(event) => { event.stopPropagation(); void removeStreamTask(stream, task.id) }}>-</button>
                  </span>
                  <span className="streamlining-next-level">
                    <span className="streamlining-branch-row"><button className="streamlining-branch-add" type="button" aria-label={`Add top option for ${task.text}`} title="Add top branch" onClick={() => void addStreamBranch(stream, task, 'top')}>+</button>{topBranches.map((branch) => renderBranchLane(stream, task, branch))}</span>
                    <span className="streamlining-branch-row"><button className="streamlining-branch-add" type="button" aria-label={`Add bottom option for ${task.text}`} title="Add bottom branch" onClick={() => void addStreamBranch(stream, task, 'bottom')}>+</button>{bottomBranches.map((branch) => renderBranchLane(stream, task, branch))}</span>
                  </span>
                </span>
                <button className="streamlining-plus" type="button" aria-label={`Add after ${task.text}`} onClick={() => void addStreamTask(stream, index + 1)}>+</button>
              </span>
            })}{!visibleTasks.length && <span className="playground-empty">Drop Scream tasks here</span>}</div><button className="streamlining-end-add" type="button" aria-label={`Add arrow to end of ${stream.name}`} title="Add arrow to end" onClick={() => void addStreamTask(stream, visibleTasks.length)}>+</button></div>
            {showRemovedStreams.has(stream.id) && removedTasks.length > 0 && <div className="streamlining-removed-list"><span className="playground-empty">Removed arrows</span>{removedTasks.map((task) => <span className="streamlining-task removed" key={`removed-${task.id}`}><span className="streamlining-task-text"><FormattedText text={task.text} /></span><button className="streamlining-restore" type="button" onClick={() => void restoreStreamTask(stream, task.id)}>Restore</button></span>)}</div>}
          </article>
        }) : <p className="playground-empty">Create a Streamlining panel to start arranging tasks.</p>}</div>
      </section>
    </>}
  </section>
}
