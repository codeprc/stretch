import { useCallback, useEffect, useRef, useState } from 'react'
import { createDiagram, fetchDiagrams, renameDiagram, saveDiagramXml, softDeleteDiagram } from '../firebase'
import type { DiagramRecord } from '../firebase'
import { DIAGRAM_QUEUE_EVENT, queuedDiagramTaskCount, takeQueuedDiagramTasks } from '../diagramQueue'

const DRAWIO_ORIGIN = 'https://embed.diagrams.net'
const MAX_XML_LENGTH = 900_000

interface DiagramEditorProps {
  diagram: DiagramRecord
  theme: string
  onSaved: (id: string, xml: string) => void
  onStatus: (message: string) => void
}

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const buildTaskCells = (tasks: string[], existingShapes: number) => {
  const cells = tasks.map((text, index) => {
    const slot = existingShapes + index
    const x = 40 + (slot % 4) * 200
    const y = 40 + Math.floor(slot / 4) * 100
    return `<mxCell id="task-${crypto.randomUUID()}" value="${escapeXml(text)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#f2d36b;strokeColor=#b99a3e;fontColor=#433317;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="170" height="70" as="geometry"/></mxCell>`
  })
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`
}

function DiagramEditor({ diagram, theme, onSaved, onStatus }: DiagramEditorProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const latestXmlRef = useRef(diagram.xml)
  const loadedRef = useRef(false)
  const diagramId = diagram.id
  const [queuedCount, setQueuedCount] = useState(queuedDiagramTaskCount)

  const insertQueuedTasks = useCallback(() => {
    const frameWindow = frameRef.current?.contentWindow
    if (!loadedRef.current || !frameWindow) return
    const tasks = takeQueuedDiagramTasks()
    setQueuedCount(0)
    if (!tasks.length) return
    const existingShapes = (latestXmlRef.current.match(/vertex="1"/g) || []).length
    frameWindow.postMessage(JSON.stringify({ action: 'merge', xml: buildTaskCells(tasks, existingShapes) }), DRAWIO_ORIGIN)
    onStatus(`Added ${tasks.length} task${tasks.length === 1 ? '' : 's'} to the diagram`)
  }, [onStatus])

  useEffect(() => {
    const handleQueue = () => { setQueuedCount(queuedDiagramTaskCount()); insertQueuedTasks() }
    window.addEventListener(DIAGRAM_QUEUE_EVENT, handleQueue)
    return () => window.removeEventListener(DIAGRAM_QUEUE_EVENT, handleQueue)
  }, [insertQueuedTasks])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== DRAWIO_ORIGIN || event.source !== frameRef.current?.contentWindow || typeof event.data !== 'string') return
      let message: { event?: string; xml?: string }
      try { message = JSON.parse(event.data) } catch { return }
      if (message.event === 'init') {
        frameRef.current?.contentWindow?.postMessage(JSON.stringify({ action: 'load', autosave: 1, xml: latestXmlRef.current }), DRAWIO_ORIGIN)
        onStatus('Ready. Changes save automatically.')
      }
      if (message.event === 'load') { loadedRef.current = true; insertQueuedTasks() }
      if ((message.event === 'autosave' || message.event === 'save') && typeof message.xml === 'string') {
        const xml = message.xml
        if (xml.length > MAX_XML_LENGTH) { onStatus('Diagram is too large to save (over 900 KB). Remove images or split it.'); return }
        latestXmlRef.current = xml
        onStatus('Saving...')
        saveDiagramXml(diagramId, xml).then(() => { onSaved(diagramId, xml); onStatus('Saved') }).catch(() => onStatus('Could not save. Check your connection.'))
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [diagramId, insertQueuedTasks, onSaved, onStatus])

  const params = new URLSearchParams({ embed: '1', proto: 'json', spin: '1', saveAndExit: '0', noExitBtn: '1', ui: theme === 'dark' ? 'dark' : 'kennedy', dark: theme === 'dark' ? '1' : '0' })
  return <>
    {queuedCount > 0 && <div className="diagram-queue-bar"><span>{queuedCount} task{queuedCount === 1 ? '' : 's'} waiting</span><button className="goal-manager-button" type="button" onClick={insertQueuedTasks}>Insert into diagram</button></div>}
    <iframe ref={frameRef} className="diagram-frame" title={`Diagram editor: ${diagram.name}`} src={`${DRAWIO_ORIGIN}/?${params.toString()}`} />
  </>
}

export function Diagrams({ theme }: { theme: string }) {
  const [diagrams, setDiagrams] = useState<DiagramRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    let active = true
    fetchDiagrams()
      .then((items) => { if (!active) return; setDiagrams(items); setSelectedId((current) => current ?? items[0]?.id ?? null) })
      .catch(() => { if (active) setMessage('Could not load diagrams.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const selected = diagrams.find((item) => item.id === selectedId) ?? null

  const addDiagram = async () => {
    const name = window.prompt('Name this diagram')?.trim()
    if (!name) return
    try {
      const created = await createDiagram(name)
      const now = new Date().toISOString()
      setDiagrams((current) => [...current, { id: created.id, name, xml: '', createdAt: now, updatedAt: now }])
      setSelectedId(created.id)
      setStatus('')
    } catch { setMessage('Could not create the diagram.') }
  }

  const rename = async (diagram: DiagramRecord) => {
    const name = window.prompt('Rename diagram', diagram.name)?.trim()
    if (!name || name === diagram.name) return
    try {
      await renameDiagram(diagram.id, name)
      setDiagrams((current) => current.map((item) => item.id === diagram.id ? { ...item, name } : item))
    } catch { setMessage('Could not rename the diagram.') }
  }

  const remove = async (diagram: DiagramRecord) => {
    if (!window.confirm(`Remove "${diagram.name}"?`)) return
    try {
      await softDeleteDiagram(diagram.id)
      const remaining = diagrams.filter((item) => item.id !== diagram.id)
      setDiagrams(remaining)
      if (selectedId === diagram.id) setSelectedId(remaining[0]?.id ?? null)
    } catch { setMessage('Could not remove the diagram.') }
  }

  const handleSaved = (id: string, xml: string) => setDiagrams((current) => current.map((item) => item.id === id ? { ...item, xml } : item))

  return <section className="diagrams-page" aria-label="Diagrams">
    <header className="playground-heading"><div><p className="eyebrow">Draw / map systems</p><h2>Diagrams</h2></div><button className="goal-manager-button" type="button" onClick={() => void addDiagram()}>+ New diagram</button></header>
    {message && <p className="holding-skill-message">{message}</p>}
    {loading ? <p className="playground-empty">Loading diagrams...</p> : <div id="diagrams-editor" className="diagrams-layout">
      <ul className="diagram-list" aria-label="Saved diagrams">
        {diagrams.length ? diagrams.map((diagram) => <li key={diagram.id} className={diagram.id === selectedId ? 'active' : ''}>
          <button className="diagram-select" type="button" aria-pressed={diagram.id === selectedId} onClick={() => { setSelectedId(diagram.id); setStatus('') }}>{diagram.name}</button>
          <button className="diagram-action" type="button" aria-label={`Rename ${diagram.name}`} title="Rename" onClick={() => void rename(diagram)}>✎</button>
          <button className="diagram-action" type="button" aria-label={`Remove ${diagram.name}`} title="Remove" onClick={() => void remove(diagram)}>-</button>
        </li>) : <li className="diagram-empty">No diagrams yet.</li>}
      </ul>
      <div className="diagram-stage">
        {selected ? <>
          <div className="diagram-stage-header"><strong>{selected.name}</strong><span role="status" aria-live="polite">{status}</span></div>
          <DiagramEditor key={`${selected.id}-${theme}`} diagram={selected} theme={theme} onSaved={handleSaved} onStatus={setStatus} />
        </> : <p className="playground-empty">Create a diagram to start drawing with draw.io.</p>}
      </div>
    </div>}
  </section>
}
