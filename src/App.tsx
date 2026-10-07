import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { TrackerCard } from './components/TrackerCard'
import { ImpossibleRepCard } from './components/ImpossibleRepCard'
import { WorkStudyCard } from './components/WorkStudyCard'
import { MSEPanel } from './components/MSEPanel'
import { MSECalendar } from './components/MSECalendar'
import { COUNTDOWN_SYNC_EVENT, loadCountdownTimers, removeStoredCountdown, toggleStoredCountdown } from './components/MSECalendar'
import type { CountdownTimer } from './components/MSECalendar'
import { HoldingSkillWizard } from './components/HoldingSkillWizard'
import { fetchIdeateIdeas, fetchMSEData, fetchStarredGoals, fetchStarredSkillIdsForGoal, saveIdeateIdea, saveStarredItem, softDeleteIdeateIdea, softDeleteStarredGoal, toggleStarredSkillMapping, updateStarredGoal } from './firebase'
import { fetchPlaygroundData, fetchStarredIdeateStrategies, fetchStarredIdeateStrategyIdeas } from './firebase'
import type { HoldingSkill, MSESkill, MSESubtask, MSETask, PlaygroundStream, PlaygroundTask, StarredIdeateEntryRecord, StarredIdeateStrategyRecord, StarredRecord, WidgetConfig } from './firebase'
import { IdeateStrategies } from './components/IdeateStrategies'
import { FormattedText } from './components/FormattedText'
import { Playground } from './components/Playground'
import { Diagrams } from './components/Diagrams'
import './App.css'

type MSESkillRow = {
  skill: string
  tasks: number
  subtasks: number
  completed: number
  remaining: number
}

type MSEData = { skills: MSESkill[]; tasks: MSETask[]; subtasks: MSESubtask[] }
type DashboardTab = 'matrix' | 'mse' | 'holding' | 'ideate' | 'playground' | 'diagrams'
interface SiteSearchResult {
  title: string
  section: string
  tab: DashboardTab
  targetId: string
  itemTitle?: string
  previousGoal?: boolean
}

interface LazyMSEPanelProps {
  skill: MSESkill
  tasks: MSETask[]
  subtasks: MSESubtask[]
  theme: string
}

function LazyMSEPanel({ skill, tasks, subtasks, theme }: LazyMSEPanelProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)

  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const observer = new IntersectionObserver(([entry]) => setNearViewport(entry.isIntersecting), { rootMargin: '500px 0px' })
    observer.observe(anchor)
    return () => observer.disconnect()
  }, [])

  return <div ref={anchorRef} id={`mse-skill-${skill.id}`} className="mse-skill-panel-anchor">
    {nearViewport ? <MSEPanel skill={skill} tasks={tasks} subtasks={subtasks} theme={theme} /> : <div className="mse-panel-placeholder" aria-hidden="true" />}
  </div>
}

type IdeateIdea = {
  id: string
  text: string
  x: number
  y: number
}

const WIDGETS: WidgetConfig[] = [
  { id: 'white', title: 'White Retention Strength', collection: 'white_retention', prefix: 'white_retention', color: '#c47b54', isStreak: false },
  { id: 'hunger', title: 'Morning Tightness Strength', collection: 'hunger_patience', prefix: 'hunger_patience', color: '#4d9b78', isStreak: false },
  { id: 'wake', title: 'Early Wake Strength', collection: 'early_wake', prefix: 'early_wake', color: '#d9a441', isStreak: true },
  { id: 'tv', title: 'TV Resistance Strength', collection: 'tv_resistance', prefix: 'tv_resistance', color: '#4d899b', isStreak: false },
  { id: 'sweet', title: 'Sweet Resistance Strength', collection: 'sweet_resistance', prefix: 'resistance', color: '#bd6b83', isStreak: false },
]

const countRecentCompletions = (dates: (string | null)[], now = Date.now(), days = 10) => dates.filter((date) => date && now - new Date(date).getTime() <= days * 24 * 60 * 60 * 1000).length
const DEFAULT_GOAL = 'MSE - Daily 10 Tasks of Each'
const SCROLL_POSITION_KEY = 'stretch-dashboard-scroll-position'
function App() {
  const [theme, setTheme] = useState('dark')
  const [activeTab, setActiveTab] = useState<DashboardTab>('mse')
  const [siteSearchOpen, setSiteSearchOpen] = useState(false)
  const [siteSearchQuery, setSiteSearchQuery] = useState('')
  const [siteSearchIndex, setSiteSearchIndex] = useState(0)
  const [playgroundSearchData, setPlaygroundSearchData] = useState<{ tasks: PlaygroundTask[]; streams: PlaygroundStream[] }>({ tasks: [], streams: [] })
  const [strategySearchData, setStrategySearchData] = useState<{ strategies: StarredIdeateStrategyRecord[]; ideas: StarredIdeateEntryRecord[] }>({ strategies: [], ideas: [] })
  const [holdingSkills, setHoldingSkills] = useState<HoldingSkill[]>([])
  const [ideateIdeas, setIdeateIdeas] = useState<IdeateIdea[]>([])
  const [ideateDraft, setIdeateDraft] = useState<{ id: string; x: number; y: number } | null>(null)
  const [ideateDraftText, setIdeateDraftText] = useState('')
  const [starredItem, setStarredItem] = useState(DEFAULT_GOAL)
  const [activeGoal, setActiveGoal] = useState('')
  const [starredGoals, setStarredGoals] = useState<StarredRecord[]>([])
  const [editingGoal, setEditingGoal] = useState(false)
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null)
  const [showPreviousGoals, setShowPreviousGoals] = useState(false)
  const goalInputRef = useRef<HTMLInputElement>(null)
  const goalSaveRef = useRef<Promise<string | null> | null>(null)
  const scrollRestoringRef = useRef(true)
  const [goalSaveStatus, setGoalSaveStatus] = useState('')
  const [starredSkills, setStarredSkills] = useState<Set<string>>(new Set())
  const [mseData, setMseData] = useState<MSEData>({ skills: [], tasks: [], subtasks: [] })
  const [countdownTimers, setCountdownTimers] = useState<Record<string, CountdownTimer>>(loadCountdownTimers)
  const [countdownNow, setCountdownNow] = useState(() => Date.now())
  const [timerControlMessage, setTimerControlMessage] = useState('')
  const [calendarOpenRequest, setCalendarOpenRequest] = useState<{ key: string; token: number } | null>(null)
  const [mseSummary, setMseSummary] = useState({
    totalItems: 0,
    subtasks: 0,
    completed: 0,
    progress: 0,
    skillRows: [] as MSESkillRow[],
    highestAttention: 'No focus yet',
    highestAttentionCount: 0,
    todoFocus: 'No focus yet',
    todoFocusCount: 0,
  })

  useEffect(() => {
    let active = true

    const refreshSummary = async () => {
      try {
        const data = await fetchMSEData()
      if (!active) return
      setMseData(data)

      let totalItems = 0
      let subtotalTasks = 0
      let completed = 0
      const skillRows: MSESkillRow[] = []
      let highestAttention = 'No focus yet'
      let highestAttentionCount = 0
      let todoFocus = 'No focus yet'
      let todoFocusCount = Number.POSITIVE_INFINITY

      data.skills.forEach((skill) => {
        const skillName = skill.skill
        const skillTasks = data.tasks.filter((task) => !task.deletedOn && (task.skill === skill.id || task.skill === skill.skill))
        const taskIds = new Set(skillTasks.map((task) => task.id))
        const skillSubtasks = data.subtasks.filter((subtask) => !subtask.deletedOn && taskIds.has(subtask.taskId))
        const taskCount = skillTasks.length
        const subtaskCount = skillSubtasks.length
        const completedTaskCount = skillTasks.filter((task) => task.completedOn).length + skillSubtasks.filter((subtask) => subtask.completedOn).length
        const totalSkillItems = taskCount + subtaskCount

        skillRows.push({
          skill: skillName, tasks: taskCount, subtasks: subtaskCount, completed: completedTaskCount, remaining: totalSkillItems - completedTaskCount,
        })

        totalItems += taskCount + subtaskCount
        subtotalTasks += subtaskCount
        completed += completedTaskCount

        const completionDates = [...skillTasks.map((task) => task.completedOn), ...skillSubtasks.map((subtask) => subtask.completedOn)]
        const recentThreeDayCompletions = countRecentCompletions(completionDates, Date.now(), 3)
        const recentTenDayCompletions = countRecentCompletions(completionDates, Date.now(), 10)

        if (recentThreeDayCompletions > highestAttentionCount) {
          highestAttention = skillName
          highestAttentionCount = recentThreeDayCompletions
        }

        if (recentTenDayCompletions < todoFocusCount) {
          todoFocus = skillName
          todoFocusCount = recentTenDayCompletions
        }
      })

      setMseSummary({
        totalItems,
        subtasks: subtotalTasks,
        completed,
        progress: totalItems ? Math.round((completed / totalItems) * 100) : 0,
        skillRows,
        highestAttention,
        highestAttentionCount,
        todoFocus,
        todoFocusCount: Number.isFinite(todoFocusCount) ? todoFocusCount : 0,
      })
      } catch {
      if (active) setMseData({ skills: [], tasks: [], subtasks: [] })
      }
    }

    void refreshSummary()
    const refreshTimer = window.setInterval(() => { void refreshSummary() }, 2000)
    const handleSync = () => { void refreshSummary() }
    window.addEventListener('mse-panel-sync', handleSync)

    return () => {
      active = false
      window.clearInterval(refreshTimer)
      window.removeEventListener('mse-panel-sync', handleSync)
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSiteSearchQuery('')
        setSiteSearchIndex(0)
        setSiteSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  }, [])

  useEffect(() => {
    if (!siteSearchOpen) return
    let active = true
    void Promise.all([fetchPlaygroundData(), fetchStarredIdeateStrategies(activeGoal)]).then(async ([playgroundData, strategies]) => {
      const ideas = (await Promise.all(strategies.map((strategy) => fetchStarredIdeateStrategyIdeas(activeGoal, strategy.id, strategy.name)))).flat()
      if (active) {
        setPlaygroundSearchData(playgroundData)
        setStrategySearchData({ strategies, ideas })
      }
    }).catch(() => {})
    return () => { active = false }
  }, [siteSearchOpen])

  useEffect(() => {
    const syncCountdowns = () => {
      setCountdownTimers(loadCountdownTimers())
      setCountdownNow(Date.now())
    }
    syncCountdowns()
    window.addEventListener(COUNTDOWN_SYNC_EVENT, syncCountdowns)
    window.addEventListener('storage', syncCountdowns)
    const timer = window.setInterval(syncCountdowns, 1000)
    return () => {
      window.removeEventListener(COUNTDOWN_SYNC_EVENT, syncCountdowns)
      window.removeEventListener('storage', syncCountdowns)
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const saveScrollPosition = () => {
      if (scrollRestoringRef.current) return
      try { window.sessionStorage.setItem(SCROLL_POSITION_KEY, String(window.scrollY)) } catch {}
    }
    window.addEventListener('scroll', saveScrollPosition, { passive: true })
    window.addEventListener('pagehide', saveScrollPosition)
    return () => {
      window.removeEventListener('scroll', saveScrollPosition)
      window.removeEventListener('pagehide', saveScrollPosition)
    }
  }, [])

  useEffect(() => {
    if (!mseData.skills.length) return
    let savedPosition = 0
    try { savedPosition = Number(window.sessionStorage.getItem(SCROLL_POSITION_KEY) || 0) } catch { scrollRestoringRef.current = false; return }
    if (!Number.isFinite(savedPosition) || savedPosition <= 0) { scrollRestoringRef.current = false; return }
    let attempts = 0
    let frame = 0
    const restorePosition = () => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      if (maxScroll >= savedPosition || attempts >= 120) {
        window.scrollTo(0, Math.min(savedPosition, maxScroll))
        scrollRestoringRef.current = false
        return
      }
      attempts += 1
      frame = window.requestAnimationFrame(restorePosition)
    }
    frame = window.requestAnimationFrame(restorePosition)
    return () => window.cancelAnimationFrame(frame)
  }, [mseData.skills.length])

  useEffect(() => {
    localStorage.removeItem('stretch-dashboard-starred-panels')
    localStorage.removeItem('stretch-dashboard-previous-starred')
    void fetchStarredGoals().then((goals) => {
      const currentGoal = goals.find((goal) => goal.active)?.item ?? goals[0]?.item ?? ''
      setStarredGoals(goals)
      setStarredItem(currentGoal || DEFAULT_GOAL)
      setActiveGoal(currentGoal)
    })
    void fetchIdeateIdeas().then((ideas) => setIdeateIdeas(ideas))
  }, [])

  useEffect(() => {
    let active = true
    if (!activeGoal) {
      setStarredSkills(new Set())
      return () => { active = false }
    }
    void fetchStarredSkillIdsForGoal(activeGoal).then((skillIds) => {
      if (active) setStarredSkills(new Set(skillIds))
    })
    return () => { active = false }
  }, [activeGoal])

  const toggleSkillStar = async (skill: MSESkill) => {
    const goal = activeGoal.trim()
    if (!goal) return
    const isStarred = await toggleStarredSkillMapping(goal, skill.id, skill.skill)
    setStarredSkills((current) => {
      const next = new Set(current)
      if (isStarred) next.add(skill.id)
      else next.delete(skill.id)
      return next
    })
  }

  const activateGoal = async (goal: string) => {
    const normalized = goal.trim()
    if (!normalized) return
    try {
      if (goalSaveRef.current) await goalSaveRef.current
      await saveStarredItem(normalized)
      setStarredItem(normalized)
      setActiveGoal(normalized)
      setEditingGoal(false)
      setShowPreviousGoals(false)
      setStarredGoals(await fetchStarredGoals())
      setGoalSaveStatus('Active goal saved')
    } catch {
      setGoalSaveStatus('Could not activate goal. Try again.')
    }
  }

  const saveGoalOnBlur = (rawValue: string) => {
    const value = rawValue.trim()
    setEditingGoal(false)
    if (!value) {
      setStarredItem(activeGoal)
      return
    }
    const editingGoalRecord = editingGoalId ? starredGoals.find((goal) => goal.id === editingGoalId) : null
    setStarredItem(value)
    let savePromise: Promise<unknown>
    if (editingGoalRecord) {
      if (editingGoalRecord.active) setActiveGoal(value)
      savePromise = updateStarredGoal(editingGoalRecord.id, value, editingGoalRecord.active)
    } else {
      savePromise = saveStarredItem(value, false)
    }
    setEditingGoalId(null)
    goalSaveRef.current = savePromise as Promise<string | null>
    void savePromise.then(async () => {
      setStarredGoals(await fetchStarredGoals())
      setGoalSaveStatus('Goal saved. Star it to make it active.')
    }).catch(() => setGoalSaveStatus('Could not save goal. Try again.'))
  }

  const handleIdeateCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('.ideate-idea-card') || target.closest('.ideate-input')) return

    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.min(Math.max(event.clientX - rect.left - 90, 18), rect.width - 200)
    const y = Math.min(Math.max(event.clientY - rect.top - 22, 18), rect.height - 60)
    const id = `ideate-${Date.now()}-${Math.random().toString(16).slice(2)}`

    setIdeateDraft({ id, x, y })
    setIdeateDraftText('')
  }

  const finalizeIdeateDraft = async () => {
    if (!ideateDraft) return

    const text = ideateDraftText.trim()
    if (!text) {
      setIdeateDraft(null)
      setIdeateDraftText('')
      return
    }

    const savedId = await saveIdeateIdea({
      id: ideateDraft.id,
      text,
      x: ideateDraft.x,
      y: ideateDraft.y,
    })

    const finalId = savedId ?? ideateDraft.id
    setIdeateIdeas((current) => [...current, { id: finalId, text, x: ideateDraft.x, y: ideateDraft.y }])
    setIdeateDraft(null)
    setIdeateDraftText('')
  }

  const removeIdeateIdea = async (ideaId: string) => {
    await softDeleteIdeateIdea(ideaId)
    setIdeateIdeas((current) => current.filter((idea) => idea.id !== ideaId))
  }

  const matrixLinks = [
    ...WIDGETS.map((config) => ({ id: `widget-${config.id}`, label: config.title })),
    { id: 'widget-work-study', label: 'Work / Study' },
    { id: 'widget-impossible', label: 'Impossible Rep' },
  ]

  const holdingLinks = holdingSkills.map((skill) => ({ id: `holding-skill-${skill.id}`, label: skill.skill }))
  const ideateLinks = [
    { id: 'ideate-board', label: 'Idea board' },
    { id: 'ideate-chain', label: 'Strategies' },
  ]
  const playgroundLinks = [
    { id: 'playground-scream', label: 'Scream' },
    { id: 'playground-streamlining', label: 'Streamlining' },
  ]

  const diagramsLinks = [
    { id: 'diagrams-editor', label: 'Diagram editor' },
  ]

  const orderedMseSkills = [...mseData.skills].sort((first, second) => Number(starredSkills.has(second.id)) - Number(starredSkills.has(first.id)))
  const searchResults: SiteSearchResult[] = [
    { title: 'Matrix', section: 'Page', tab: 'matrix', targetId: 'widget-white' },
    { title: 'MSE', section: 'Page', tab: 'mse', targetId: 'mse-calendar' },
    { title: 'Learn Holding', section: 'Page', tab: 'holding', targetId: 'widget-holding-skills' },
    { title: 'Ideate', section: 'Page', tab: 'ideate', targetId: 'ideate-board' },
    { title: 'Playground', section: 'Page', tab: 'playground', targetId: 'playground-scream' },
    { title: 'Diagrams', section: 'Page', tab: 'diagrams', targetId: 'diagrams-editor' },
    { title: 'Goal manager', section: 'Goals', tab: activeTab, targetId: 'goal-manager' },
    ...starredGoals.map((goal) => ({ title: goal.item, section: 'Goal', tab: activeTab, targetId: goal.item === activeGoal ? 'goal-manager' : `goal-item-${goal.id}`, previousGoal: goal.item !== activeGoal })),
    ...WIDGETS.map((widget) => ({ title: widget.title, section: 'Matrix', tab: 'matrix' as const, targetId: `widget-${widget.id}` })),
    { title: 'Work / Study', section: 'Matrix', tab: 'matrix', targetId: 'widget-work-study' },
    { title: 'Impossible Rep', section: 'Matrix', tab: 'matrix', targetId: 'widget-impossible' },
    ...holdingSkills.map((skill) => ({ title: skill.skill, section: 'Learn Holding', tab: 'holding' as const, targetId: 'widget-holding-skills' })),
    { title: 'Idea board', section: 'Ideate', tab: 'ideate', targetId: 'ideate-board' },
    { title: 'Strategies', section: 'Ideate', tab: 'ideate', targetId: 'ideate-chain' },
    ...ideateIdeas.map((idea) => ({ title: idea.text, section: 'Idea', tab: 'ideate' as const, targetId: `ideate-idea-${idea.id}` })),
    ...strategySearchData.strategies.map((strategy) => ({ title: strategy.name, section: 'Strategy', tab: 'ideate' as const, targetId: `ideate-strategy-${strategy.id}` })),
    ...strategySearchData.ideas.map((idea) => ({ title: idea.text, section: 'Strategy arrow', tab: 'ideate' as const, targetId: `ideate-arrow-${idea.id}` })),
    { title: 'Scream', section: 'Playground', tab: 'playground', targetId: 'playground-scream' },
    { title: 'Streamlining', section: 'Playground', tab: 'playground', targetId: 'playground-streamlining' },
    ...playgroundSearchData.tasks.map((task) => ({ title: task.text, section: 'Scream task', tab: 'playground' as const, targetId: `playground-task-${task.id}` })),
    ...playgroundSearchData.streams.map((stream) => ({ title: stream.name, section: 'Streamlining', tab: 'playground' as const, targetId: `playground-stream-${stream.id}` })),
    { title: 'Schedule', section: 'MSE', tab: 'mse', targetId: 'mse-calendar' },
    { title: 'Aggregate table', section: 'MSE', tab: 'mse', targetId: 'mse-overview' },
    { title: 'Overall MSE status', section: 'MSE', tab: 'mse', targetId: 'mse-status' },
    { title: 'Current focus', section: 'MSE', tab: 'mse', targetId: 'mse-focus' },
    ...mseData.skills.map((skill) => ({ title: skill.skill, section: 'MSE skill', tab: 'mse' as const, targetId: `mse-skill-${skill.id}` })),
    ...mseData.tasks.filter((task) => !task.deletedOn).map((task) => {
      const skill = mseData.skills.find((entry) => entry.id === task.skill || entry.skill === task.skill)
      return { title: task.task, section: skill?.skill || 'MSE task', tab: 'mse' as const, targetId: skill ? `mse-skill-${skill.id}` : 'mse-calendar', itemTitle: task.task }
    }),
    ...mseData.subtasks.filter((subtask) => !subtask.deletedOn).map((subtask) => {
      const task = mseData.tasks.find((entry) => entry.id === subtask.taskId)
      const skill = task && mseData.skills.find((entry) => entry.id === task.skill || entry.skill === task.skill)
      return { title: subtask.subtask, section: `${skill?.skill || 'MSE'} subtask`, tab: 'mse' as const, targetId: skill ? `mse-skill-${skill.id}` : 'mse-calendar', itemTitle: subtask.subtask }
    }),
  ]
  const filteredSearchResults = searchResults.filter((result) => !siteSearchQuery.trim() || `${result.title} ${result.section}`.toLowerCase().includes(siteSearchQuery.trim().toLowerCase())).slice(0, 40)
  const goToSearchResult = (result: SiteSearchResult) => {
    setSiteSearchOpen(false)
    setSiteSearchQuery('')
    if (result.previousGoal) setShowPreviousGoals(true)
    setActiveTab(result.tab)
    let attempts = 0
    const findAndScroll = () => {
      const target = document.getElementById(result.targetId)
      const item = result.itemTitle && target
        ? [...target.querySelectorAll<HTMLElement>('.mse-todo-row > span, .mse-subtodo-row > span')].find((element) => element.textContent?.trim() === result.itemTitle)?.closest<HTMLElement>('.mse-todo-row, .mse-subtodo-row')
        : null
      if (target && (!result.itemTitle || item)) {
        const destination = item || target
        destination.scrollIntoView({ behavior: 'smooth', block: 'center' })
        destination.classList.add('site-search-target')
        window.setTimeout(() => destination.classList.remove('site-search-target'), 1800)
        return
      }
      if (attempts === 0) target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      attempts += 1
      if (attempts < 50) window.setTimeout(findAndScroll, 100)
    }
    window.setTimeout(findAndScroll, 50)
  }
  const floatingCountdowns = Object.entries(countdownTimers)
    .filter(([, timer]) => timer.deadline !== null || timer.updatedAt)
    .sort((first, second) => {
      const firstRunning = first[1].deadline !== null && first[1].deadline > countdownNow
      const secondRunning = second[1].deadline !== null && second[1].deadline > countdownNow
      return Number(secondRunning) - Number(firstRunning) || (second[1].updatedAt ?? 0) - (first[1].updatedAt ?? 0)
    })
    .slice(0, 4)
    .map(([key, timer]) => {
      const type = key.startsWith('subtask-') ? 'subtask' : 'task'
      const id = key.slice(type.length + 1)
      const item = type === 'task'
        ? mseData.tasks.find((task) => task.id === id)?.task
        : mseData.subtasks.find((subtask) => subtask.id === id)?.subtask
      const isRunning = Boolean(timer.deadline && timer.deadline > countdownNow)
      const secondsLeft = timer.deadline === null ? timer.remainingSeconds : Math.max(0, Math.ceil((timer.deadline - countdownNow) / 1000))
      const time = isRunning || secondsLeft === 0
        ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
        : `${Math.ceil(secondsLeft / 60)}m`
      const status = isRunning ? 'RUNNING' : secondsLeft === timer.totalSeconds ? 'READY' : 'PAUSED'
      return { key, title: item || 'Scheduled task', time, status, isRunning, totalSeconds: timer.totalSeconds }
    })
  const mseLinks = [
    { id: 'mse-calendar', label: 'Schedule' },
    { id: 'mse-overview', label: 'Aggregate table' },
    { id: 'mse-status', label: 'Overall MSE status' },
    { id: 'mse-focus', label: 'Current focus' },
    ...orderedMseSkills.map((skill) => ({ id: `mse-skill-${skill.id}`, label: skill.skill })),
  ]

  return <main className="dashboard-container">
    <header className="top-bar"><div><p className="eyebrow">Personal discipline / live log</p><h1 className="main-heading">Stretch Me <span>Dashboard</span></h1></div><div className="top-bar-actions"><label className="theme-wrapper"><span>{theme === 'dark' ? 'Night view' : 'Day view'}</span><span className="switch"><input type="checkbox" checked={theme === 'dark'} onChange={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} /><span className="slider" /></span></label></div></header>
    {floatingCountdowns.length > 0 && <aside className="active-countdowns active-countdowns-floating" aria-label="Countdown controls" aria-live="polite"><span>Working on</span><ul>{floatingCountdowns.map((timer) => <li key={timer.key}><button type="button" aria-label={`${timer.isRunning ? 'Pause' : 'Start'} ${timer.title}`} title={`${timer.isRunning ? 'Pause' : 'Start'} countdown`} onClick={() => { const toggled = toggleStoredCountdown(timer.key, timer.totalSeconds); setTimerControlMessage(toggled ? '' : 'Two timers are already running. Pause one before starting another.') }}>{timer.isRunning ? 'Ⅱ' : '▶'}</button><button className="active-countdown-open" type="button" title={`Open ${timer.title}`} onClick={() => { setCalendarOpenRequest({ key: timer.key, token: Date.now() }); setActiveTab('mse') }}>{timer.title}</button><small>{timer.status}</small><time>{timer.time}</time><button type="button" aria-label={`Stop ${timer.title}`} title="Stop and remove" onClick={() => { removeStoredCountdown(timer.key); setTimerControlMessage('') }}>■</button></li>)}</ul>{timerControlMessage && <p role="status">{timerControlMessage}</p>}</aside>}
    <nav className="tab-bar" aria-label="Dashboard sections"><button className={`tab-button${activeTab === 'matrix' ? ' active' : ''}`} aria-selected={activeTab === 'matrix'} onClick={() => setActiveTab('matrix')}>Matrix</button><button className={`tab-button${activeTab === 'mse' ? ' active' : ''}`} aria-selected={activeTab === 'mse'} onClick={() => setActiveTab('mse')}>MSE</button><button className={`tab-button${activeTab === 'holding' ? ' active' : ''}`} aria-selected={activeTab === 'holding'} onClick={() => setActiveTab('holding')}>Learn Holding</button><button className={`tab-button${activeTab === 'ideate' ? ' active' : ''}`} aria-selected={activeTab === 'ideate'} onClick={() => setActiveTab('ideate')}>Ideate</button><button className={`tab-button${activeTab === 'playground' ? ' active' : ''}`} aria-selected={activeTab === 'playground'} onClick={() => setActiveTab('playground')}>Playground</button><button className={`tab-button${activeTab === 'diagrams' ? ' active' : ''}`} aria-selected={activeTab === 'diagrams'} onClick={() => setActiveTab('diagrams')}>Diagrams</button></nav>
    <section id="goal-manager" className="goal-manager" aria-label="Goal manager">
      <div className="goal-entry-row">
        <button className={`goal-star-button${starredItem.trim() === activeGoal && activeGoal ? ' active' : ''}`} type="button" disabled={!starredItem.trim()} aria-label={starredItem.trim() === activeGoal && activeGoal ? 'Active goal' : 'Set this goal as active'} aria-pressed={starredItem.trim() === activeGoal && Boolean(activeGoal)} title={starredItem.trim() === activeGoal && activeGoal ? 'Active goal' : 'Set as active goal'} onClick={() => void activateGoal(starredItem)}>{starredItem.trim() === activeGoal && activeGoal ? '★' : '☆'}</button>
        {editingGoal ? <label className="starred-item-editor"><input ref={goalInputRef} autoFocus className="dashboard-note-input" value={starredItem} placeholder="New goal" aria-label="Goal" onChange={(event) => { setStarredItem(event.target.value); setGoalSaveStatus('') }} onBlur={(event) => saveGoalOnBlur(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label> : <h3 className="goal-heading" tabIndex={0} onDoubleClick={() => { setEditingGoalId(starredGoals.find((goal) => goal.item === starredItem)?.id ?? null); setEditingGoal(true); setGoalSaveStatus('') }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setEditingGoalId(starredGoals.find((goal) => goal.item === starredItem)?.id ?? null); setEditingGoal(true); setGoalSaveStatus('') } }}><FormattedText text={starredItem || DEFAULT_GOAL} /></h3>}
      </div>
      <p className="goal-save-status" role="status" aria-live="polite">{goalSaveStatus}</p>
      <div className="goal-manager-actions">
        <button className="goal-manager-button" type="button" onClick={() => { setEditingGoalId(null); setEditingGoal(true); setStarredItem(''); setShowPreviousGoals(false); requestAnimationFrame(() => goalInputRef.current?.focus()) }}>Add more goal</button>
        <button className="goal-manager-button" type="button" aria-expanded={showPreviousGoals} onClick={() => setShowPreviousGoals((shown) => !shown)}>{showPreviousGoals ? 'Hide previous starred' : 'Previous starred'}</button>
      </div>
      {showPreviousGoals && <div className="goal-history-list">{starredGoals.filter((goal) => goal.item !== activeGoal).length ? starredGoals.filter((goal) => goal.item !== activeGoal).map((goal) => <div id={`goal-item-${goal.id}`} className="goal-history-item" key={goal.item}><button className="goal-history-select" type="button" onClick={() => void activateGoal(goal.item)}><span aria-hidden="true">★</span><span><FormattedText text={goal.item} /></span></button><button className="goal-history-remove" type="button" aria-label={`Remove ${goal.item}`} title="Remove goal" onClick={async () => { await softDeleteStarredGoal(goal.id); setStarredGoals((current) => current.filter((item) => item.id !== goal.id)) }}>-</button></div>) : <p className="goal-history-empty">No previous goals.</p>}</div>}
    </section>
    <div className="dashboard-shell">
      <aside className="dashboard-rail" aria-label="Quick navigation">
        <div className="rail-panel">
          <span className="rail-heading">Jump to</span>
          <div className="rail-link-list">
          {(activeTab === 'matrix' ? matrixLinks : activeTab === 'mse' ? mseLinks : activeTab === 'holding' ? holdingLinks : activeTab === 'ideate' ? ideateLinks : activeTab === 'playground' ? playgroundLinks : diagramsLinks).map((link) => {
            const skill = activeTab === 'mse' ? mseData.skills.find((entry) => `mse-skill-${entry.id}` === link.id) : undefined
            const isStarred = skill ? starredSkills.has(skill.id) : false
            return <div key={link.id} className="rail-link-row">{skill && <button className={`rail-star${isStarred ? ' starred' : ''}`} type="button" disabled={!activeGoal.trim()} aria-label={`${isStarred ? 'Unstar' : 'Star'} ${link.label}${activeGoal.trim() ? '' : ', enter a goal first'}`} aria-pressed={isStarred} title={activeGoal.trim() ? `${isStarred ? 'Remove' : 'Add'} ${link.label} ${isStarred ? 'from' : 'to'} this goal` : 'Enter a goal first'} onClick={() => void toggleSkillStar(skill)}>{isStarred ? '★' : '☆'}</button>}<a className="rail-link" href={`#${link.id}`}><FormattedText text={link.label} /></a></div>
          })}
          </div>
        </div>
      </aside>
      <div className="dashboard-main-column">
        {activeTab === 'matrix' ? (
          <>
            <section className="intro-row"><p>Small promises, measured honestly.</p><span>Firestore / live connection</span></section>
            <div className="grid-container">
              {WIDGETS.map((config) => <div id={`widget-${config.id}`} key={config.id} className="panel-anchor"><TrackerCard config={config} theme={theme} /></div>)}
              <div id="widget-work-study" className="panel-anchor"><WorkStudyCard theme={theme} /></div>
              <div id="widget-impossible" className="panel-anchor"><ImpossibleRepCard theme={theme} /></div>
            </div>
          </>
        ) : activeTab === 'holding' ? (
          <section className="holding-page">
            <div className="holding-page-heading"><p className="eyebrow">Practice / duration log</p><h2>Learn Holding</h2></div>
            <div id="widget-holding-skills" className="panel-anchor"><HoldingSkillWizard theme={theme} onSkillsLoaded={setHoldingSkills} /></div>
          </section>
        ) : activeTab === 'ideate' ? (
          <section className="ideate-tab" aria-label="Ideate board">
            <div className="ideate-page-heading"><p className="eyebrow">Generate / shape ideas</p><h2>Ideate</h2></div>
            <div id="ideate-board" className="ideate-panel">
              <div className="ideate-upper-panel" onClick={handleIdeateCanvasClick} aria-label="Ideas board">
                <div className="ideate-section-header"><span>Ideas</span></div>
                <span className="ideate-board-hint">Click anywhere to add an idea</span>
                {ideateIdeas.map((idea, index) => <div id={`ideate-idea-${idea.id}`} key={idea.id} className="ideate-idea-card" style={{ left: idea.x, top: idea.y, background: ['#4d9b78', '#d9a441', '#4d899b', '#bd6b83', '#c47b54', '#5a7ba0'][index % 6] }} draggable onDragStart={(event) => { event.dataTransfer.setData('text/plain', idea.id); event.dataTransfer.effectAllowed = 'move' }}><button className="ideate-remove-button" type="button" aria-label={`Remove ${idea.text}`} onClick={(event) => { event.stopPropagation(); void removeIdeateIdea(idea.id) }}>-</button><p><FormattedText text={idea.text} /></p></div>)}
                {ideateDraft && <div className="ideate-input-wrap" style={{ left: ideateDraft.x, top: ideateDraft.y }}><input className="ideate-input" value={ideateDraftText} autoFocus onChange={(event) => setIdeateDraftText(event.target.value)} onBlur={finalizeIdeateDraft} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} aria-label="New idea" placeholder="Write your idea" /></div>}
              </div>
              <IdeateStrategies key={activeGoal} goal={activeGoal} ideas={ideateIdeas} />
            </div>
          </section>
        ) : activeTab === 'playground' ? <Playground /> : activeTab === 'diagrams' ? <Diagrams theme={theme} /> : (
          <section className="mse-panel">
            <h2>Making MSE Happening</h2>
            <div id="mse-calendar"><MSECalendar tasks={mseData.tasks} subtasks={mseData.subtasks} skills={mseData.skills} openRequest={calendarOpenRequest} onOpenRequestHandled={() => setCalendarOpenRequest(null)} /></div>
            <div id="mse-overview" className="mse-overview-block">
              <div className="mse-skill-table-wrap">
                <table className="mse-skill-table">
                  <thead><tr><th>Skill</th><th>Tasks</th><th>Subtasks</th><th>Completed</th><th>Remaining</th></tr></thead>
                  <tbody>{mseSummary.skillRows.map((row) => <tr key={row.skill}><td><FormattedText text={row.skill} /></td><td>{row.tasks}</td><td>{row.subtasks}</td><td>{row.completed}</td><td>{row.remaining}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="mse-summary-panel">
                <div id="mse-status" className="mse-summary-card">
                  <div className="mse-summary-header"><span>Overall MSE status</span><strong>{mseData.skills.length} skills</strong></div>
                  <div className="mse-summary-body"><div><label>Tasks</label><strong>{mseSummary.totalItems - mseSummary.subtasks}</strong></div><div><label>Subtasks</label><strong>{mseSummary.subtasks}</strong></div><div><label>Progress</label><strong>{mseSummary.progress}%</strong></div></div>
                </div>
                <div id="mse-focus" className="mse-summary-card">
                  <div className="mse-summary-header"><span>Current focus</span><strong>Live insight</strong></div>
                  <div className="mse-summary-body"><div><label>Total skills</label><strong>{mseData.skills.length}</strong></div><div><label>Highest attention skill</label><strong><FormattedText text={mseSummary.highestAttention} /></strong></div><div><label>Lowest attention skill</label><strong><FormattedText text={mseSummary.todoFocus} /></strong></div></div>
                </div>
              </div>
            </div>
            <div className="mse-grid">{mseData.skills.map((skill) => <LazyMSEPanel key={skill.id} skill={skill} tasks={mseData.tasks.filter((task) => task.skill === skill.id || task.skill === skill.skill)} subtasks={mseData.subtasks} theme={theme} />)}</div>
          </section>
        )}
      </div>
    </div>
    {siteSearchOpen && <div className="site-search-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSiteSearchOpen(false) }}><section className="site-search-dialog" role="dialog" aria-modal="true" aria-label="Search the whole site"><div className="site-search-input-row"><span aria-hidden="true">⌕</span><input autoFocus value={siteSearchQuery} placeholder="Search goals, skills, tasks, and pages" aria-label="Search the whole site" aria-controls="site-search-results" onChange={(event) => { setSiteSearchQuery(event.target.value); setSiteSearchIndex(0) }} onKeyDown={(event) => { if (event.key === 'Escape') setSiteSearchOpen(false); if (event.key === 'ArrowDown') { event.preventDefault(); setSiteSearchIndex((index) => Math.min(index + 1, filteredSearchResults.length - 1)) } if (event.key === 'ArrowUp') { event.preventDefault(); setSiteSearchIndex((index) => Math.max(0, index - 1)) } if (event.key === 'Enter' && filteredSearchResults[siteSearchIndex]) { event.preventDefault(); goToSearchResult(filteredSearchResults[siteSearchIndex]) } }} /><kbd>ESC</kbd></div><ul id="site-search-results" className="site-search-results" role="listbox">{filteredSearchResults.map((result, index) => <li key={`${result.tab}-${result.targetId}-${result.title}`}><button type="button" role="option" aria-selected={index === siteSearchIndex} className={index === siteSearchIndex ? 'selected' : ''} onMouseEnter={() => setSiteSearchIndex(index)} onClick={() => goToSearchResult(result)}><span>{result.title}</span><small>{result.section}</small></button></li>)}{filteredSearchResults.length === 0 && <li className="site-search-empty">No matching places found.</li>}</ul><footer><span>↑↓ Navigate</span><span>Enter Go</span><span>Esc Close</span></footer></section></div>}
    <button className="go-to-top-button" type="button" aria-label="Go to top" title="Go to top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>↑</button>
  </main>
}

export default App
