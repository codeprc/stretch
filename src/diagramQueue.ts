const QUEUE_KEY = 'stretch-dashboard-diagram-queue'
export const DIAGRAM_QUEUE_EVENT = 'diagram-queue-sync'

const readQueue = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(QUEUE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

export const queueTaskForDiagram = (text: string) => {
  window.localStorage.setItem(QUEUE_KEY, JSON.stringify([...readQueue(), text]))
  window.dispatchEvent(new Event(DIAGRAM_QUEUE_EVENT))
}

export const queuedDiagramTaskCount = () => readQueue().length

export const takeQueuedDiagramTasks = () => {
  const queued = readQueue()
  window.localStorage.removeItem(QUEUE_KEY)
  return queued
}
