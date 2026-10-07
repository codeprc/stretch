import { initializeApp } from 'firebase/app'
import { addDoc, collection, deleteDoc, deleteField, doc, getDoc, getDocs, getFirestore, query, updateDoc, where, writeBatch } from 'firebase/firestore'
import { playCompletionBell, stopCountdownForCompletedItem } from './completionEffects'

const firebaseConfig = {
  apiKey: 'AIzaSyAjayg8hqM-LdC3G2g2oFu-SAePxpakAAQ',
  authDomain: 'stretch-codeprc.firebaseapp.com',
  projectId: 'stretch-codeprc',
  storageBucket: 'stretch-codeprc.firebasestorage.app',
  messagingSenderId: '631508117938',
  appId: '1:631508117938:web:884920cbd7e2066b5ddcab',
}

export const db = getFirestore(initializeApp(firebaseConfig))

export interface WidgetConfig {
  id: string
  title: string
  collection: string
  prefix: string
  color: string
  isStreak: boolean
}

export interface HistoryItem {
  index: number
  durationMillis: number
  durationHours: number
  durationDays: number
}

export interface WidgetRecord {
  id: string
  fromMs: number
  tillMs: number | null
  updatedMs: number | null
}

export interface ImpossibleRepHistoryItem {
  date: string
  max: number
}

export async function fetchImpossibleRepHistory() {
  const snapshot = await getDocs(collection(db, 'gym_impossible_rep'))
  const dailyMax = new Map<string, number>()

  snapshot.forEach((docSnapshot) => {
    const data = docSnapshot.data()
    const date = String(data.gym_date || '')
    const max = Number(data.impossible_rep_max)
    if (date && Number.isFinite(max) && max > 0) dailyMax.set(date, Math.max(dailyMax.get(date) ?? 0, max))
  })

  return [...dailyMax.entries()]
    .sort(([firstDate], [secondDate]) => firstDate.localeCompare(secondDate))
    .slice(-7)
    .map(([date, max]) => ({ date, max }))
}

export interface WorkStudyHistoryItem {
  date: string
  minutes: number
  location: string
}

export async function fetchWorkStudyHistory() {
  const snapshot = await getDocs(collection(db, 'study_work_willpower_strength'))
  return snapshot.docs
    .map((docSnapshot) => {
      const data = docSnapshot.data()
      const timestamp = String(data.session_date_time || '')
      const minutes = Number(data.session_minutes_stretched)
      const location = typeof data.location === 'string' ? data.location.trim() : ''
      return { timestamp, minutes, location }
    })
    .filter((item) => item.location && item.timestamp && Number.isFinite(item.minutes) && item.minutes > 0)
    .sort((first, second) => first.timestamp.localeCompare(second.timestamp))
    .slice(-7)
    .map(({ timestamp, minutes, location }) => ({
      date: new Intl.DateTimeFormat(undefined, { day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp)),
      minutes,
      location,
    }))
}

export async function fetchWidgetData(config: WidgetConfig) {
  const snapshot = await getDocs(collection(db, config.collection))
  const records: WidgetRecord[] = []
  const history: HistoryItem[] = []
  let maxLastUpdated: number | null = null

  snapshot.forEach((docSnapshot) => {
    const data = docSnapshot.data()
    const fromMs = data[`${config.prefix}_from`] ? Number(data[`${config.prefix}_from`]) : null
    const tillMs = data[`${config.prefix}_till`] ? Number(data[`${config.prefix}_till`]) : null
    const updatedMs = data[`${config.prefix}_last_updated`] ? Number(data[`${config.prefix}_last_updated`]) : null
    if (updatedMs && (!maxLastUpdated || updatedMs > maxLastUpdated)) maxLastUpdated = updatedMs
    if (fromMs) records.push({ id: docSnapshot.id, fromMs, tillMs, updatedMs })
  })

  records.sort((first, second) => first.fromMs - second.fromMs)
  let index = 1
  records.forEach((record) => {
    if (record.tillMs && record.tillMs >= record.fromMs) {
      const durationMillis = record.tillMs - record.fromMs
      const startDay = new Date(record.fromMs).setHours(0, 0, 0, 0)
      const endDay = new Date(record.tillMs).setHours(0, 0, 0, 0)
      const countedDays = Math.max(0, Math.round((endDay - startDay) / 86400000) + 1 - (config.isStreak && endDay === new Date().setHours(0, 0, 0, 0) ? 1 : 0))
      history.push({
        index: index++,
        durationMillis,
        durationHours: Number((durationMillis / 3600000).toFixed(2)),
        durationDays: countedDays,
      })
    }
  })

  const openSession = [...records].reverse().find((record) => !record.tillMs)
  return { history, records, latestRecord: openSession ?? records.at(-1) ?? null, maxLastUpdated }
}

export async function stopWidgetCounter(config: WidgetConfig) {
  const nowString = String(Date.now())
  const snapshot = await getDocs(collection(db, config.collection))
  const updates: Promise<void>[] = []

  snapshot.forEach((docSnapshot) => {
    const data = docSnapshot.data()
    if (!data[`${config.prefix}_till`] || data[`${config.prefix}_till`] === '') {
      updates.push(updateDoc(doc(db, config.collection, docSnapshot.id), {
        [`${config.prefix}_till`]: nowString,
        [`${config.prefix}_last_updated`]: nowString,
      }))
    }
  })

  await Promise.all(updates)
}

export async function resetWidgetCounter(config: WidgetConfig) {
  const nowString = String(Date.now())
  const resetEndMs = config.isStreak ? new Date().setHours(0, 0, 0, 0) - 1 : Date.now()
  const resetEndString = String(resetEndMs)
  const collectionReference = collection(db, config.collection)
  const snapshot = await getDocs(collectionReference)
  const updates: Promise<void>[] = []

  snapshot.forEach((docSnapshot) => {
    const data = docSnapshot.data()
    if (!data[`${config.prefix}_till`] || data[`${config.prefix}_till`] === '') {
      updates.push(updateDoc(doc(db, config.collection, docSnapshot.id), {
        [`${config.prefix}_till`]: resetEndString,
        [`${config.prefix}_last_updated`]: nowString,
      }))
    }
  })

  await Promise.all(updates)
  await addDoc(collectionReference, {
    [`${config.prefix}_from`]: nowString,
    [`${config.prefix}_till`]: '',
    [`${config.prefix}_last_updated`]: nowString,
  })
}

export async function startStreakCounter(config: WidgetConfig) {
  const nowString = String(Date.now())
  const collectionReference = collection(db, config.collection)
  const snapshot = await getDocs(collectionReference)
  const hasOpenSession = snapshot.docs.some((docSnapshot) => {
    const till = docSnapshot.data()[`${config.prefix}_till`]
    return !till || till === ''
  })

  if (!hasOpenSession) {
    await addDoc(collectionReference, {
      [`${config.prefix}_from`]: nowString,
      [`${config.prefix}_till`]: '',
      [`${config.prefix}_last_updated`]: nowString,
    })
  }
}

export async function submitStreakCounter(config: WidgetConfig) {
  const resetEndString = String(new Date().setHours(0, 0, 0, 0) - 1)
  const snapshot = await getDocs(collection(db, config.collection))
  const updates: Promise<void>[] = []

  snapshot.forEach((docSnapshot) => {
    const data = docSnapshot.data()
    if (!data[`${config.prefix}_till`] || data[`${config.prefix}_till`] === '') {
      updates.push(updateDoc(doc(db, config.collection, docSnapshot.id), {
        [`${config.prefix}_till`]: resetEndString,
        [`${config.prefix}_last_updated`]: String(Date.now()),
      }))
    }
  })

  await Promise.all(updates)
}

export interface MSESkill {
  id: string
  skill: string
  subtext: string
}

export interface MSETask {
  id: string
  task: string
  skill: string
  createdOn: string
  completedOn: string | null
  deletedOn: string | null
  scheduledOn: string | null
  scheduleOrder: number | null
  scheduledStartTime: string | null
  scheduledDurationMinutes: number | null
  scheduledNotes: string
}

export interface MSESubtask {
  id: string
  taskId: string
  subtask: string
  createdOn: string
  completedOn: string | null
  deletedOn: string | null
  scheduledOn: string | null
  scheduleOrder: number | null
  scheduledStartTime: string | null
  scheduledDurationMinutes: number | null
  scheduledNotes: string
}

export interface HoldingSkill {
  id: string
  skill: string
  span: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
}

export interface HoldingSkillRecording {
  id: string
  skillId: string
  startTime: string
  endTime: string | null
}

export interface StarredRecord {
  id: string
  item: string
  active: boolean
  createdAt: string
  deletedOn?: string | null
}

export interface IdeateIdeaRecord {
  id: string
  text: string
  x: number
  y: number
  createdAt: string
}

export interface StarredIdeateRecord {
  id: string
  goal: string
  ideaId: string
  text: string
  order: number
  createdAt: string
}

export interface StarredSkillRecord {
  id: string
  item: string
  skillId: string
  skillName: string
  createdAt: string
}

export async function fetchStarredGoals(): Promise<StarredRecord[]> {
  const snapshot = await getDocs(collection(db, 'starred'))
  const goals = new Map<string, StarredRecord>()

  snapshot.forEach((docSnapshot) => {
    const data = docSnapshot.data()
    if (data.deletedOn) return
    const rawValue = data.item ?? data.items
    if (typeof rawValue === 'string') {
      const item = rawValue.trim()
      if (item && !goals.has(item)) goals.set(item, {
        id: docSnapshot.id,
        item,
        active: data.active === true,
        createdAt: readDate(data.createdAt) || new Date().toISOString(),
        deletedOn: readDate(data.deletedOn),
      })
      return
    }
    if (Array.isArray(rawValue)) {
      rawValue.forEach((value) => {
        if (typeof value === 'string') {
          const item = value.trim()
          if (item && !goals.has(item)) goals.set(item, {
            id: docSnapshot.id,
            item,
            active: data.active === true,
            createdAt: readDate(data.createdAt) || new Date().toISOString(),
            deletedOn: readDate(data.deletedOn),
          })
        }
      })
    }
  })

  return [...goals.values()].sort((first, second) => Number(second.active) - Number(first.active) || second.createdAt.localeCompare(first.createdAt))
}

export async function saveStarredItem(item: string, activate = true) {
  const normalized = item.trim()
  if (!normalized) return null

  const snapshot = await getDocs(collection(db, 'starred'))
  const matching = snapshot.docs.filter((docSnapshot) => {
    const data = docSnapshot.data()
    return data.item === normalized || data.items === normalized || (Array.isArray(data.items) && data.items.includes(normalized))
  })
  const selected = matching[0]
  const duplicateIds = new Set(matching.slice(1).map((docSnapshot) => docSnapshot.id))
  const updatedAt = new Date().toISOString()
  const selectedRef = selected?.ref ?? doc(collection(db, 'starred'))
  const legacyItems = selected && Array.isArray(selected.data().items)
    ? selected.data().items.filter((value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.trim() !== normalized)
    : []
  const batch = writeBatch(db)

  if (activate) {
    snapshot.docs.forEach((docSnapshot) => {
      if (docSnapshot.id !== selectedRef.id && !duplicateIds.has(docSnapshot.id)) batch.update(docSnapshot.ref, { active: false, updatedAt })
    })
  }

  if (selected) {
    batch.update(selectedRef, { item: normalized, items: deleteField(), ...(activate ? { active: true } : {}), updatedAt })
    matching.slice(1).forEach((docSnapshot) => batch.delete(docSnapshot.ref))
    legacyItems.forEach((legacyItem: string) => {
      const legacyRef = doc(collection(db, 'starred'))
      batch.set(legacyRef, {
      item: legacyItem.trim(),
      active: false,
      createdAt: updatedAt,
      updatedAt,
      })
    })
  } else {
    batch.set(selectedRef, { item: normalized, active: activate, createdAt: updatedAt, updatedAt })
  }
  await batch.commit()
  return selectedRef.id
}

export async function fetchIdeateIdeas() {
  const snapshot = await getDocs(collection(db, 'ideate'))
  return snapshot.docs
    .map((docSnapshot) => {
      const data = docSnapshot.data()
      if (data.deletedOn) return null
      const text = typeof data.text === 'string' ? data.text.trim() : ''
      const x = typeof data.x === 'number' ? data.x : 0
      const y = typeof data.y === 'number' ? data.y : 0
      return {
        id: docSnapshot.id,
        text,
        x,
        y,
        createdAt: readDate(data.createdAt) || new Date().toISOString(),
      }
    })
    .filter((idea): idea is { id: string; text: string; x: number; y: number; createdAt: string } => Boolean(idea?.text))
    .sort((first, second) => first.createdAt.localeCompare(second.createdAt))
}

export async function saveIdeateIdea(idea: { id: string; text: string; x: number; y: number }) {
  const text = idea.text.trim()
  if (!text) return null

  const payload = {
    text,
    x: idea.x,
    y: idea.y,
    createdAt: new Date().toISOString(),
  }

  if (idea.id && idea.id.startsWith('ideate-')) {
    const snapshot = await getDocs(collection(db, 'ideate'))
    const existing = snapshot.docs.find((docSnapshot) => docSnapshot.id === idea.id)
    if (existing) {
      await updateDoc(existing.ref, payload)
      return existing.id
    }
  }

  const created = await addDoc(collection(db, 'ideate'), payload)
  return created.id
}

export async function fetchStarredIdeateIdeas(goal: string) {
  const normalizedGoal = goal.trim()
  if (!normalizedGoal) return []

  const snapshot = await getDocs(collection(db, 'starred_ideate'))
  const unassigned = snapshot.docs.filter((docSnapshot) => {
    const existingGoal = docSnapshot.data().goal
    return typeof existingGoal !== 'string' || !existingGoal.trim()
  })
  const unassignedIds = new Set(unassigned.map((docSnapshot) => docSnapshot.id))
  await Promise.all(unassigned.map((docSnapshot) => updateDoc(docSnapshot.ref, { goal: normalizedGoal })))

  return snapshot.docs
    .map((docSnapshot) => {
      const data = docSnapshot.data()
      const text = typeof data.text === 'string' ? data.text.trim() : ''
      return {
        id: docSnapshot.id,
        goal: normalizedGoal,
        ideaId: typeof data.ideaId === 'string' ? data.ideaId : docSnapshot.id,
        text,
        order: Number(data.order) || 0,
        createdAt: readDate(data.createdAt) || new Date().toISOString(),
      }
    })
    .filter((idea) => idea.text && (idea.goal === normalizedGoal || unassignedIds.has(idea.id)))
    .sort((first, second) => first.order - second.order || first.createdAt.localeCompare(second.createdAt))
}

export async function replaceStarredIdeateIdeas(goal: string, ideas: Array<{ id: string; text: string }>) {
  const normalizedGoal = goal.trim()
  if (!normalizedGoal) return

  const snapshot = await getDocs(collection(db, 'starred_ideate'))
  const existingForGoal = snapshot.docs.filter((docSnapshot) => docSnapshot.data().goal === normalizedGoal)
  await Promise.all(existingForGoal.map((docSnapshot) => deleteDoc(docSnapshot.ref)))

  const normalized = ideas.filter((idea) => idea.text.trim())
  await Promise.all(normalized.map((idea, index) => addDoc(collection(db, 'starred_ideate'), {
    goal: normalizedGoal,
    ideaId: idea.id,
    text: idea.text.trim(),
    order: index,
    createdAt: new Date().toISOString(),
  })))
}

export async function fetchStarredSkillIdsForGoal(goal: string) {
  const normalizedGoal = goal.trim()
  if (!normalizedGoal) return []

  const snapshot = await getDocs(query(collection(db, 'starred_skill'), where('item', '==', normalizedGoal)))
  return [...new Set(snapshot.docs
    .map((docSnapshot) => docSnapshot.data().skillId)
    .filter((skillId): skillId is string => typeof skillId === 'string' && Boolean(skillId)))]
}

export async function toggleStarredSkillMapping(goal: string, skillId: string, skillName: string) {
  const normalizedGoal = goal.trim()
  if (!normalizedGoal || !skillId || !skillName) return false

  const goalMappings = await getDocs(query(collection(db, 'starred_skill'), where('item', '==', normalizedGoal)))
  const matching = goalMappings.docs.filter((docSnapshot) => docSnapshot.data().skillId === skillId)
  if (matching.length) {
    await Promise.all(matching.map((docSnapshot) => deleteDoc(docSnapshot.ref)))
    return false
  }

  await addDoc(collection(db, 'starred_skill'), {
    item: normalizedGoal,
    skillId,
    skillName,
    createdAt: new Date().toISOString(),
  })
  return true
}

export async function fetchHoldingSkillData() {
  const [skillsSnapshot, recordingsSnapshot] = await Promise.all([
    getDocs(collection(db, 'Holding_Myself_Long_Skills')),
    getDocs(collection(db, 'Holding_Myself_Long_Skills_Recording')),
  ])
  const skills: HoldingSkill[] = skillsSnapshot.docs
    .map((snapshot) => {
      const data = snapshot.data()
      const spanValue = String(data.Span || data.span || 'hour').trim().toLowerCase().replace(/s$/, '')
      const supportedSpans: HoldingSkill['span'][] = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year']
      const span = supportedSpans.find((value) => value === spanValue) || 'hour'
      return {
        id: snapshot.id,
        skill: String(data.skill || '').trim(),
        span,
      }
    })
    .filter((skill) => skill.skill)
    .sort((first, second) => first.skill.localeCompare(second.skill))
  const recordings: HoldingSkillRecording[] = recordingsSnapshot.docs
    .map((snapshot) => {
      const data = snapshot.data()
      return {
        id: snapshot.id,
        skillId: String(data.skillId || ''),
        startTime: readDate(data.startTime) || '',
        endTime: readDate(data.endTime),
      }
    })
    .filter((recording) => recording.skillId && recording.startTime)
    .sort((first, second) => first.startTime.localeCompare(second.startTime))

  return { skills, recordings }
}

export async function startHoldingSkillRecording(skillId: string) {
  const recordingsSnapshot = await getDocs(collection(db, 'Holding_Myself_Long_Skills_Recording'))
  const hasOpenRecording = recordingsSnapshot.docs.some((snapshot) => {
    const data = snapshot.data()
    const existingSkillId = typeof data.skillId === 'string' ? data.skillId.trim() : ''
    const startTime = readDate(data.startTime)
    return Boolean(existingSkillId && startTime && Number.isFinite(new Date(startTime).getTime()) && !readDate(data.endTime))
  })
  if (hasOpenRecording) throw new Error('End the active recording before starting another.')

  return addDoc(collection(db, 'Holding_Myself_Long_Skills_Recording'), {
    skillId,
    startTime: new Date().toISOString(),
    endTime: null,
  })
}

export async function endHoldingSkillRecording(recordingId: string) {
  await updateDoc(doc(db, 'Holding_Myself_Long_Skills_Recording', recordingId), {
    endTime: new Date().toISOString(),
  })
}

const defaultMSESkills = [
  'Debating Skills',
  'Kannada Skills',
  'Public Spaking Skills',
  'Mob Handling Skills',
  'Dealing No & Sidelining Skills',
  'Finding the Key Person who can help Skills',
  'Making Sure to Keep Family Expenses on high levels always Skills',
  'Practice get beaten in various ways Skills',
]

const normalizeSkillName = (value: string) => value.trim().replace(/\s+/g, ' ')

const readDate = (value: unknown): string | null => {
  if (!value) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number') return new Date(value).toISOString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && value !== null && 'toDate' in value && typeof value.toDate === 'function') return value.toDate().toISOString()
  return String(value)
}

export async function fetchMSEData() {
  let skillsSnapshot = await getDocs(collection(db, 'mse_skills'))
  const existingSkills = new Set(
    skillsSnapshot.docs
      .flatMap((snapshot) => {
        const data = snapshot.data()
        return [data.skill, data.original_skill]
      })
      .map((skill) => normalizeSkillName(String(skill || '')))
      .filter(Boolean)
      .map((skill) => skill.toLowerCase()),
  )
  const missingSkills = defaultMSESkills.filter((skill) => !existingSkills.has(normalizeSkillName(skill).toLowerCase()))
  if (missingSkills.length) {
    await Promise.all(missingSkills.map((skill) => addDoc(collection(db, 'mse_skills'), { skill })))
    skillsSnapshot = await getDocs(collection(db, 'mse_skills'))
  }

  const [tasksSnapshot, subtasksSnapshot, calendarSnapshot] = await Promise.all([
    getDocs(collection(db, 'mse_skill_tasks')),
    getDocs(collection(db, 'mse_skill_subtasks')),
    getDocs(collection(db, 'calendar')),
  ])

  const schedules = new Map<string, { date: string; order: number; startTime: string; durationMinutes: number; notes: string }>()
  calendarSnapshot.docs.forEach((snapshot) => {
    const data = snapshot.data()
    const type = data.item_type
    const itemId = data.item_id
    const date = String(data.date || '')
    if ((type !== 'task' && type !== 'subtask') || typeof itemId !== 'string' || !date || data.deleted_on) return
    const order = Number.isFinite(Number(data.order)) ? Number(data.order) : 0
    const totalMinutes = 300 + order * 25
    const startTime = String(data.start_time || `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`)
    const storedDuration = Number(data.duration_minutes)
    const durationMinutes = !Number.isFinite(storedDuration) || storedDuration <= 0 ? 25 : storedDuration
    schedules.set(`${type}:${itemId}`, { date, order, startTime, durationMinutes, notes: String(data.notes || '') })
  })

  const seenSkills = new Map<string, MSESkill>()
  const skills: MSESkill[] = skillsSnapshot.docs.reduce<MSESkill[]>((items, snapshot) => {
    const data = snapshot.data()
    const skillName = normalizeSkillName(String(data.skill || snapshot.id))
    if (!skillName) return items

    const key = skillName.toLowerCase()
    if (!seenSkills.has(key)) {
      seenSkills.set(key, { id: snapshot.id, skill: skillName, subtext: String(data.subtext || '') })
      items.push(seenSkills.get(key) as MSESkill)
    }

    return items
  }, [])
  const tasks: MSETask[] = tasksSnapshot.docs.map((snapshot) => {
    const data = snapshot.data()
    const schedule = schedules.get(`task:${snapshot.id}`)
    return { id: snapshot.id, task: String(data.task || ''), skill: String(data.skill || ''), createdOn: readDate(data.created_on) || '', completedOn: readDate(data.completed_on), deletedOn: readDate(data.deleted_on), scheduledOn: schedule?.date || null, scheduleOrder: schedule?.order ?? null, scheduledStartTime: schedule?.startTime || null, scheduledDurationMinutes: schedule?.durationMinutes ?? null, scheduledNotes: schedule?.notes || '' }
  }).filter((task) => task.task)
  const subtasks: MSESubtask[] = subtasksSnapshot.docs.map((snapshot) => {
    const data = snapshot.data()
    const schedule = schedules.get(`subtask:${snapshot.id}`)
    return { id: snapshot.id, taskId: String(data.task_id || ''), subtask: String(data.subtask || ''), createdOn: readDate(data.created_on) || '', completedOn: readDate(data.completed_on), deletedOn: readDate(data.deleted_on), scheduledOn: schedule?.date || null, scheduleOrder: schedule?.order ?? null, scheduledStartTime: schedule?.startTime || null, scheduledDurationMinutes: schedule?.durationMinutes ?? null, scheduledNotes: schedule?.notes || '' }
  }).filter((subtask) => subtask.taskId && subtask.subtask)

  return { skills, tasks, subtasks }
}

export async function createMSETask(task: string, skill: string) {
  return addDoc(collection(db, 'mse_skill_tasks'), { task, skill, created_on: new Date().toISOString(), completed_on: null, deleted_on: null })
}

export interface PlaygroundTask {
  id: string
  text: string
  sourceTaskId: string
  createdAt: string
}

export interface PlaygroundBranch {
  id: string
  parentTaskId: string
  parentBranchId?: string
  position: 'top' | 'bottom'
  text: string
}

export interface PlaygroundStream {
  id: string
  name: string
  taskIds: string[]
  removedTaskIds: string[]
  createdAt: string
  scrollAfterFive: boolean
  branches: PlaygroundBranch[]
}

export async function fetchPlaygroundData() {
  const [taskSnapshot, streamSnapshot] = await Promise.all([
    getDocs(collection(db, 'screming_tasks')),
    getDocs(collection(db, 'streamlining_tasks')),
  ])
  const tasks: PlaygroundTask[] = taskSnapshot.docs.map((snapshot) => {
    const data = snapshot.data()
    return { id: snapshot.id, text: String(data.text || ''), sourceTaskId: String(data.source_task_id || ''), createdAt: readDate(data.created_at) || '' }
  }).filter((task) => task.text && !taskSnapshot.docs.find((snapshot) => snapshot.id === task.id)?.data().deleted_on)
  const streams: PlaygroundStream[] = streamSnapshot.docs.map((snapshot) => {
    const data = snapshot.data()
    const branches = Array.isArray(data.branches) ? data.branches.filter((branch): branch is PlaygroundBranch => typeof branch === 'object' && branch !== null && typeof branch.id === 'string' && typeof branch.parentTaskId === 'string' && (branch.parentBranchId === undefined || typeof branch.parentBranchId === 'string') && (branch.position === 'top' || branch.position === 'bottom') && typeof branch.text === 'string') : []
    return { id: snapshot.id, name: String(data.name || 'Streamlining'), taskIds: Array.isArray(data.task_ids) ? data.task_ids.filter((id): id is string => typeof id === 'string') : [], removedTaskIds: Array.isArray(data.removed_task_ids) ? data.removed_task_ids.filter((id): id is string => typeof id === 'string') : [], createdAt: readDate(data.created_at) || '', scrollAfterFive: typeof data.scroll_after_five === 'boolean' ? data.scroll_after_five : true, branches }
  }).filter((stream) => stream.name && !streamSnapshot.docs.find((snapshot) => snapshot.id === stream.id)?.data().deleted_on)
  return { tasks, streams }
}

export async function createPlaygroundTask(text: string, sourceTaskId: string) {
  const existing = await getDocs(query(collection(db, 'screming_tasks'), where('source_task_id', '==', sourceTaskId)))
  if (existing.docs.length) {
    await updateDoc(existing.docs[0].ref, { text: text.trim(), deleted_on: null, updated_at: new Date().toISOString() })
    return existing.docs[0].ref
  }
  return addDoc(collection(db, 'screming_tasks'), { text: text.trim(), source_task_id: sourceTaskId, created_at: new Date().toISOString(), deleted_on: null })
}

export async function updatePlaygroundTask(sourceTaskId: string, text: string) {
  const existing = await getDocs(query(collection(db, 'screming_tasks'), where('source_task_id', '==', sourceTaskId)))
  await Promise.all(existing.docs.map((snapshot) => updateDoc(snapshot.ref, { text: text.trim(), updated_at: new Date().toISOString() })))
}

export async function softDeletePlaygroundTask(taskId: string) {
  await updateDoc(doc(db, 'screming_tasks', taskId), { deleted_on: new Date().toISOString() })
}

export interface DiagramRecord {
  id: string
  name: string
  xml: string
  createdAt: string
  updatedAt: string
}

export async function fetchDiagrams() {
  const snapshot = await getDocs(collection(db, 'draw_io'))
  return snapshot.docs
    .filter((entry) => !entry.data().deleted_on)
    .map((entry): DiagramRecord => {
      const data = entry.data()
      return { id: entry.id, name: String(data.name || 'Untitled diagram'), xml: typeof data.xml === 'string' ? data.xml : '', createdAt: readDate(data.created_at) || '', updatedAt: readDate(data.updated_at) || '' }
    })
    .sort((first, second) => first.createdAt.localeCompare(second.createdAt))
}

export async function createDiagram(name: string) {
  return addDoc(collection(db, 'draw_io'), { name: name.trim() || 'Untitled diagram', xml: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_on: null })
}

export async function saveDiagramXml(diagramId: string, xml: string) {
  await updateDoc(doc(db, 'draw_io', diagramId), { xml, updated_at: new Date().toISOString() })
}

export async function renameDiagram(diagramId: string, name: string) {
  await updateDoc(doc(db, 'draw_io', diagramId), { name: name.trim(), updated_at: new Date().toISOString() })
}

export async function softDeleteDiagram(diagramId: string) {
  await updateDoc(doc(db, 'draw_io', diagramId), { deleted_on: new Date().toISOString() })
}

export async function createPlaygroundStream(name: string) {
  return addDoc(collection(db, 'streamlining_tasks'), { name: name.trim() || 'Streamlining', task_ids: [], branches: [], scroll_after_five: true, created_at: new Date().toISOString(), deleted_on: null })
}

export async function updatePlaygroundStreamScroll(streamId: string, scrollAfterFive: boolean) {
  await updateDoc(doc(db, 'streamlining_tasks', streamId), { scroll_after_five: scrollAfterFive, updated_at: new Date().toISOString() })
}

export async function updatePlaygroundStreamBranches(streamId: string, branches: PlaygroundBranch[]) {
  await updateDoc(doc(db, 'streamlining_tasks', streamId), { branches, updated_at: new Date().toISOString() })
}

export async function updatePlaygroundStreamName(streamId: string, name: string) {
  await updateDoc(doc(db, 'streamlining_tasks', streamId), { name: name.trim(), updated_at: new Date().toISOString() })
}

export async function softDeletePlaygroundStream(streamId: string) {
  await updateDoc(doc(db, 'streamlining_tasks', streamId), { deleted_on: new Date().toISOString(), updated_at: new Date().toISOString() })
}

export async function updatePlaygroundStreamTasks(streamId: string, taskIds: string[], removedTaskIds?: string[]) {
  const updates: Record<string, unknown> = { task_ids: taskIds, updated_at: new Date().toISOString() }
  if (removedTaskIds) updates.removed_task_ids = removedTaskIds
  await updateDoc(doc(db, 'streamlining_tasks', streamId), updates)
}

export async function updatePlaygroundStreamRemovedTasks(streamId: string, taskIds: string[]) {
  await updateDoc(doc(db, 'streamlining_tasks', streamId), { removed_task_ids: taskIds, updated_at: new Date().toISOString() })
}

export async function updateMSESkill(skillId: string, currentSkill: string, skill: string) {
  const normalizedSkill = normalizeSkillName(skill)
  if (!normalizedSkill) return

  const skillUpdate: { skill: string; original_skill?: string } = { skill: normalizedSkill }
  if (defaultMSESkills.some((defaultSkill) => normalizeSkillName(defaultSkill).toLowerCase() === currentSkill.toLowerCase())) {
    skillUpdate.original_skill = currentSkill
  }

  const legacyTasks = await getDocs(query(collection(db, 'mse_skill_tasks'), where('skill', '==', currentSkill)))
  await Promise.all([
    updateDoc(doc(db, 'mse_skills', skillId), skillUpdate),
    ...legacyTasks.docs.map((task) => updateDoc(task.ref, { skill: normalizedSkill })),
  ])
}

export async function updateMSESkillSubtext(skillId: string, subtext: string) {
  await updateDoc(doc(db, 'mse_skills', skillId), { subtext })
}

export async function updateMSETask(taskId: string, task: string) {
  await updateDoc(doc(db, 'mse_skill_tasks', taskId), { task })
}

export async function updateMSESubtask(subtaskId: string, subtask: string) {
  await updateDoc(doc(db, 'mse_skill_subtasks', subtaskId), { subtask })
}

export async function deleteMSESubtask(subtaskId: string, deleted = true) {
  await updateDoc(doc(db, 'mse_skill_subtasks', subtaskId), { deleted_on: deleted ? new Date().toISOString() : null })
}

export async function createMSESubtask(taskId: string, subtask: string) {
  return addDoc(collection(db, 'mse_skill_subtasks'), { task_id: taskId, subtask, created_on: new Date().toISOString(), completed_on: null, deleted_on: null })
}

export async function scheduleMSEItem(type: 'task' | 'subtask', id: string, date: string, targetMinute?: number, requestedDurationMinutes?: number) {
  const calendar = collection(db, 'calendar')
  const itemDocumentId = `${type}-${id}`
  const currentSnapshot = await getDoc(doc(calendar, itemDocumentId))
  const currentData = currentSnapshot.exists() ? currentSnapshot.data() : null
  const sourceDate = String(currentData?.date || '')
  const targetSnapshot = await getDocs(query(calendar, where('date', '==', date)))
  const sourceSnapshot = sourceDate && sourceDate !== date
    ? await getDocs(query(calendar, where('date', '==', sourceDate)))
    : targetSnapshot
  const readEntry = (documentId: string, data: Record<string, unknown>) => {
    const order = Number(data.order) || 0
    const savedTime = String(data.start_time || '')
    const [savedHour, savedMinute] = savedTime.split(':').map(Number)
    const startMinute = Number.isFinite(savedHour) && Number.isFinite(savedMinute) ? savedHour * 60 + savedMinute : 300 + order * 25
    const savedDuration = Number(data.duration_minutes)
    const durationMinutes = !Number.isFinite(savedDuration) || savedDuration <= 0 ? 25 : savedDuration
    return {
      documentId,
      type: data.item_type as 'task' | 'subtask',
      id: String(data.item_id || ''),
      order,
      startMinute,
      durationMinutes,
    }
  }
  const targetEntries = targetSnapshot.docs.map((snapshot) => readEntry(snapshot.id, snapshot.data()))
    .filter((entry) => entry.type !== type || entry.id !== id)
    .sort((first, second) => first.startMinute - second.startMinute || first.order - second.order)
  const currentEntry = currentData ? readEntry(itemDocumentId, currentData) : null
  const durationMinutes = requestedDurationMinutes ?? currentEntry?.durationMinutes ?? 25
  const lastEnd = targetEntries.reduce((latest, entry) => Math.max(latest, entry.startMinute + entry.durationMinutes), 300)
  const desiredStart = targetMinute ?? (sourceDate === date && currentEntry ? currentEntry.startMinute : lastEnd)
  const movingEntry = {
    documentId: itemDocumentId,
    type,
    id,
    order: currentEntry?.order ?? targetEntries.length,
    startMinute: Math.max(300, Math.round(desiredStart)),
    durationMinutes,
  }
  const insertionIndex = targetEntries.findIndex((entry) => entry.startMinute >= movingEntry.startMinute)
  targetEntries.splice(insertionIndex < 0 ? targetEntries.length : insertionIndex, 0, movingEntry)
  targetEntries.forEach((entry, order) => { entry.order = order })
  if (targetEntries.some((entry) => entry.startMinute + entry.durationMinutes > 23 * 60)) {
    throw new Error('Calendar items must end by 11 PM.')
  }

  const sourceEntries = sourceDate && sourceDate !== date
    ? sourceSnapshot.docs.map((snapshot) => readEntry(snapshot.id, snapshot.data()))
      .filter((entry) => entry.type !== type || entry.id !== id)
      .sort((first, second) => first.startMinute - second.startMinute || first.order - second.order)
    : []
  const batch = writeBatch(db)
  const writeDay = (day: string, entries: typeof targetEntries) => entries.forEach((entry, order) => {
    const startTime = `${String(Math.floor(entry.startMinute / 60)).padStart(2, '0')}:${String(entry.startMinute % 60).padStart(2, '0')}`
    batch.set(doc(calendar, entry.documentId), {
      item_type: entry.type,
      item_id: entry.id,
      date: day,
      order,
      start_time: startTime,
      duration_minutes: entry.durationMinutes,
      deleted_on: null,
      updated_at: new Date().toISOString(),
    }, { merge: true })
  })
  if (sourceEntries.length) writeDay(sourceDate, sourceEntries)
  writeDay(date, targetEntries)
  await batch.commit()
}

export async function softDeleteMSECalendarItem(type: 'task' | 'subtask', id: string) {
  await updateDoc(doc(db, 'calendar', `${type}-${id}`), { deleted_on: new Date().toISOString() })
}

export async function updateMSECalendarNotes(type: 'task' | 'subtask', id: string, notes: string) {
  await updateDoc(doc(db, 'calendar', `${type}-${id}`), { notes, updated_at: new Date().toISOString() })
}

export async function setMSETaskCompleted(taskId: string, completed: boolean) {
  await updateDoc(doc(db, 'mse_skill_tasks', taskId), { completed_on: completed ? new Date().toISOString() : null })
  if (completed) {
    playCompletionBell()
    stopCountdownForCompletedItem('task', taskId)
  }
}

export async function setMSESubtaskCompleted(subtaskId: string, completed: boolean) {
  await updateDoc(doc(db, 'mse_skill_subtasks', subtaskId), { completed_on: completed ? new Date().toISOString() : null })
  if (completed) {
    playCompletionBell()
    stopCountdownForCompletedItem('subtask', subtaskId)
  }
}

export async function deleteMSETask(taskId: string, deleted: boolean) {
  const subtasksSnapshot = await getDocs(query(collection(db, 'mse_skill_subtasks'), where('task_id', '==', taskId)))
  const deletedOn = deleted ? new Date().toISOString() : null
  await Promise.all([
    updateDoc(doc(db, 'mse_skill_tasks', taskId), { deleted_on: deletedOn }),
    ...subtasksSnapshot.docs.map((snapshot) => updateDoc(snapshot.ref, { deleted_on: deletedOn })),
  ])
}

export interface StarredIdeateStrategyRecord {
  id: string
  goal: string
  name: string
  order: number
  createdAt: string
  scrollAfterFive: boolean
}

export interface StarredIdeateEntryRecord {
  id: string
  goal: string
  strategyId: string
  ideaId: string
  text: string
  order: number
  createdAt: string
  deletedOn?: string | null
}

const DEFAULT_STRATEGY_NAME = 'Top Strategy'

export async function fetchStarredIdeateStrategies(goal: string): Promise<StarredIdeateStrategyRecord[]> {
  const normalizedGoal = goal.trim()
  if (!normalizedGoal) return []

  const snapshot = await getDocs(collection(db, 'starred_ideate_strategy'))
  let strategies = snapshot.docs
    .filter((docSnapshot) => docSnapshot.data().goal === normalizedGoal)
    .map((docSnapshot) => {
      const data = docSnapshot.data()
      return {
        id: docSnapshot.id,
        goal: normalizedGoal,
        name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : DEFAULT_STRATEGY_NAME,
        order: Number(data.order) || 0,
        createdAt: readDate(data.createdAt) || new Date().toISOString(),
        scrollAfterFive: typeof data.scrollAfterFive === 'boolean' ? data.scrollAfterFive : true,
      }
    })

  const defaultRef = doc(db, 'starred_ideate_strategy', `default-${encodeURIComponent(normalizedGoal)}`)
  const existingDefault = strategies.find((strategy) => strategy.id === defaultRef.id || strategy.name === DEFAULT_STRATEGY_NAME || strategy.name === 'Idea Settling')
  if (existingDefault) {
    const remaining = strategies.filter((strategy) => strategy.id !== existingDefault.id)
      .sort((first, second) => first.order - second.order)
    const batch = writeBatch(db)
    batch.update(doc(db, 'starred_ideate_strategy', existingDefault.id), { name: DEFAULT_STRATEGY_NAME, order: 0 })
    remaining.forEach((strategy, index) => batch.update(doc(db, 'starred_ideate_strategy', strategy.id), { order: index + 1 }))
    await batch.commit()
    strategies = [{ ...existingDefault, name: DEFAULT_STRATEGY_NAME, order: 0 }, ...remaining.map((strategy, index) => ({ ...strategy, order: index + 1 }))]
  } else {
    const batch = writeBatch(db)
    strategies.forEach((strategy, index) => batch.update(doc(db, 'starred_ideate_strategy', strategy.id), { order: index + 1 }))
    batch.set(defaultRef, {
      goal: normalizedGoal,
      name: DEFAULT_STRATEGY_NAME,
      order: 0,
      createdAt: new Date().toISOString(),
    }, { merge: true })
    await batch.commit()
    strategies = [{ id: defaultRef.id, goal: normalizedGoal, name: DEFAULT_STRATEGY_NAME, order: 0, createdAt: new Date().toISOString(), scrollAfterFive: true }, ...strategies.map((strategy, index) => ({ ...strategy, order: index + 1 }))]
  }

  return strategies.sort((first, second) => first.order - second.order || first.createdAt.localeCompare(second.createdAt))
}

export async function createStarredIdeateStrategy(goal: string, name: string, order: number) {
  const normalizedGoal = goal.trim()
  const normalizedName = name.trim()
  if (!normalizedGoal || !normalizedName) return null
  const created = await addDoc(collection(db, 'starred_ideate_strategy'), {
    goal: normalizedGoal,
    name: normalizedName,
    order,
    scrollAfterFive: true,
    createdAt: new Date().toISOString(),
  })
  return created.id
}

export async function saveStarredIdeateStrategyName(strategyId: string, name: string) {
  const normalizedName = name.trim()
  if (!strategyId || !normalizedName || normalizedName === DEFAULT_STRATEGY_NAME || strategyId.startsWith('default-')) return
  await updateDoc(doc(db, 'starred_ideate_strategy', strategyId), { name: normalizedName, updatedAt: new Date().toISOString() })
}

export async function saveStarredIdeateStrategyOrder(goal: string, orderedIds: string[]) {
  const normalizedGoal = goal.trim()
  if (!normalizedGoal) return
  const snapshot = await getDocs(collection(db, 'starred_ideate_strategy'))
  const byId = new Map(snapshot.docs
    .filter((docSnapshot) => docSnapshot.data().goal === normalizedGoal)
    .map((docSnapshot) => [docSnapshot.id, docSnapshot.ref]))
  const batch = writeBatch(db)
  orderedIds.forEach((id, order) => {
    const ref = byId.get(id)
    if (ref) batch.update(ref, { order })
  })
  await batch.commit()
}

export async function fetchStarredIdeateStrategyIdeas(goal: string, strategyId: string, strategyName: string, includeDeleted = false): Promise<StarredIdeateEntryRecord[]> {
  const normalizedGoal = goal.trim()
  if (!normalizedGoal || !strategyId) return []

  const snapshot = await getDocs(collection(db, 'starred_ideate'))
  return snapshot.docs
    .filter((docSnapshot) => {
      const data = docSnapshot.data()
      const belongsToGoal = data.goal === normalizedGoal
      const isDeleted = Boolean(data.deletedOn)
      const assignedStrategy = typeof data.strategyId === 'string' && data.strategyId
      return belongsToGoal && (includeDeleted || !isDeleted) && (assignedStrategy === strategyId || (!assignedStrategy && (strategyName === DEFAULT_STRATEGY_NAME || strategyName === 'Idea Settling')))
    })
    .map((docSnapshot) => {
      const data = docSnapshot.data()
      return {
        id: docSnapshot.id,
        goal: normalizedGoal,
        strategyId,
        ideaId: typeof data.ideaId === 'string' ? data.ideaId : docSnapshot.id,
        text: typeof data.text === 'string' ? data.text.trim() : '',
        order: Number(data.order) || 0,
        createdAt: readDate(data.createdAt) || new Date().toISOString(),
        deletedOn: readDate(data.deletedOn),
      }
    })
    .filter((entry) => entry.text)
    .sort((first, second) => first.order - second.order || first.createdAt.localeCompare(second.createdAt))
}

export async function replaceStarredIdeateStrategyIdeas(goal: string, strategyId: string, ideas: Array<{ id: string; ideaId: string; text: string }>) {
  const normalizedGoal = goal.trim()
  if (!normalizedGoal || !strategyId) return

  const snapshot = await getDocs(collection(db, 'starred_ideate'))
  const existing = snapshot.docs.filter((docSnapshot) => {
    const data = docSnapshot.data()
    if (data.deletedOn) return false
    const belongsToGoal = data.goal === normalizedGoal
    const assignedStrategy = typeof data.strategyId === 'string' && data.strategyId
    return belongsToGoal && (assignedStrategy === strategyId || (!assignedStrategy && strategyId.startsWith('default-')))
  })
  const incomingIds = new Set(ideas.map((idea) => idea.id))
  const batch = writeBatch(db)
  existing.forEach((docSnapshot) => {
    if (!incomingIds.has(docSnapshot.id)) batch.delete(docSnapshot.ref)
  })
  ideas.forEach((idea, order) => {
    batch.set(doc(db, 'starred_ideate', idea.id), {
      goal: normalizedGoal,
      strategyId,
      ideaId: idea.ideaId,
      text: idea.text.trim(),
      order,
      createdAt: new Date().toISOString(),
    })
  })
  await batch.commit()
}

export async function softDeleteStarredIdeateStrategyIdea(entryId: string) {
  await updateDoc(doc(db, 'starred_ideate', entryId), { deletedOn: new Date().toISOString(), updatedAt: new Date().toISOString() })
}

export async function restoreStarredIdeateStrategyIdea(entryId: string) {
  await updateDoc(doc(db, 'starred_ideate', entryId), { deletedOn: deleteField(), updatedAt: new Date().toISOString() })
}

export async function softDeleteIdeateIdea(ideaId: string) {
  await updateDoc(doc(db, 'ideate', ideaId), { deletedOn: new Date().toISOString() })
}

export async function updateStarredGoal(goalId: string, item: string, active: boolean) {
  const goalRef = doc(db, 'starred', goalId)
  const goalSnapshot = await getDoc(goalRef)
  const previousItem = String(goalSnapshot.data()?.item || '').trim()
  const nextItem = item.trim()
  const batch = writeBatch(db)
  batch.update(goalRef, { item: nextItem, active, updatedAt: new Date().toISOString() })
  if (previousItem && previousItem !== nextItem) {
    const mappings = await getDocs(query(collection(db, 'starred_skill'), where('item', '==', previousItem)))
    mappings.docs.forEach((mapping) => batch.update(mapping.ref, { item: nextItem }))
  }
  await batch.commit()
}

export async function softDeleteStarredGoal(goalId: string) {
  await updateDoc(doc(db, 'starred', goalId), { deletedOn: new Date().toISOString(), active: false, updatedAt: new Date().toISOString() })
}

export async function saveStarredIdeateStrategyScroll(strategyId: string, scrollAfterFive: boolean) {
  await updateDoc(doc(db, 'starred_ideate_strategy', strategyId), { scrollAfterFive })
}