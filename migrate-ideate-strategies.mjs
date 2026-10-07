import { initializeApp } from 'firebase/app'
import { collection, doc, getDocs, getFirestore, writeBatch } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyAjayg8hqM-LdC3G2g2oFu-SAePxpakAA',
  authDomain: 'stretch-codeprc.firebaseapp.com',
  projectId: 'stretch-codeprc',
  storageBucket: 'stretch-codeprc.firebasestorage.app',
  messagingSenderId: '631508117938',
  appId: '1:631508117938:web:884920cbd7e2066b5ddcab',
}

const defaultGoal = 'MSE - Daily 10 Tasks of Each'
const applyChanges = process.argv.includes('--apply')
const db = getFirestore(initializeApp(firebaseConfig))
const [goalsSnapshot, strategiesSnapshot, ideasSnapshot] = await Promise.all([
  getDocs(collection(db, 'starred')),
  getDocs(collection(db, 'starred_ideate_strategy')),
  getDocs(collection(db, 'starred_ideate')),
])

const namesFromGoalRecord = (data) => {
  const values = Array.isArray(data.items) ? data.items : [data.item ?? data.items]
  return values.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
}

const goals = [...new Set(goalsSnapshot.docs.flatMap((snapshot) => namesFromGoalRecord(snapshot.data())))]
const activeGoalRecord = goalsSnapshot.docs.find((snapshot) => snapshot.data().active === true)
const activeGoal = activeGoalRecord
  ? namesFromGoalRecord(activeGoalRecord.data())[0]
  : goals.find((goal) => goal === defaultGoal) || goals[0] || defaultGoal
if (!goals.length) goals.push(activeGoal)

const strategiesByGoal = new Map()
strategiesSnapshot.docs.forEach((snapshot) => {
  const data = snapshot.data()
  if (typeof data.goal !== 'string' || !data.goal.trim()) return
  const existing = strategiesByGoal.get(data.goal) || []
  existing.push({ id: snapshot.id, ref: snapshot.ref, name: String(data.name || '').trim(), order: Number(data.order) || 0 })
  strategiesByGoal.set(data.goal, existing)
})

const defaultStrategyIds = new Map()
const operations = []
let strategiesToCreate = 0
const ensureDefaultStrategy = (goal) => {
  if (defaultStrategyIds.has(goal)) return defaultStrategyIds.get(goal)
  const existing = strategiesByGoal.get(goal) || []
  const defaultStrategy = existing.find((strategy) => strategy.name === 'Top Strategy' || strategy.name === 'Idea Settling')
  if (defaultStrategy) {
    defaultStrategyIds.set(goal, defaultStrategy.id)
    if (defaultStrategy.name !== 'Top Strategy') operations.push((batch) => batch.update(defaultStrategy.ref, { name: 'Top Strategy' }))
    return defaultStrategy.id
  }

  const id = `default-${encodeURIComponent(goal)}`
  const reference = doc(db, 'starred_ideate_strategy', id)
  existing.forEach((strategy) => operations.push((batch) => batch.update(strategy.ref, { order: strategy.order + 1 })))
  operations.push((batch) => batch.set(reference, {
    goal,
    name: 'Top Strategy',
    order: 0,
    createdAt: new Date().toISOString(),
  }, { merge: true }))
  strategiesToCreate += 1
  defaultStrategyIds.set(goal, id)
  return id
}

goals.forEach(ensureDefaultStrategy)

const validStrategyIds = new Map()
strategiesSnapshot.docs.forEach((snapshot) => {
  const data = snapshot.data()
  if (typeof data.goal !== 'string') return
  const ids = validStrategyIds.get(data.goal) || new Set()
  ids.add(snapshot.id)
  validStrategyIds.set(data.goal, ids)
})

const orderedIdeas = ideasSnapshot.docs
  .map((snapshot) => ({ snapshot, data: snapshot.data() }))
  .sort((first, second) => (Number(first.data.order) || 0) - (Number(second.data.order) || 0)
    || String(first.data.createdAt || '').localeCompare(String(second.data.createdAt || '')))
const nextOrder = new Map()
let ideasToAssign = 0
orderedIdeas.forEach(({ snapshot, data }) => {
  const goal = typeof data.goal === 'string' && data.goal.trim() ? data.goal.trim() : activeGoal
  const defaultStrategyId = ensureDefaultStrategy(goal)
  const knownStrategies = validStrategyIds.get(goal) || new Set()
  const existingStrategyId = typeof data.strategyId === 'string' ? data.strategyId : ''
  const strategyId = knownStrategies.has(existingStrategyId) ? existingStrategyId : defaultStrategyId
  const orderKey = `${goal}\u0000${strategyId}`
  const order = nextOrder.get(orderKey) || 0
  nextOrder.set(orderKey, order + 1)
  if (data.goal !== goal || data.strategyId !== strategyId || Number(data.order) !== order) ideasToAssign += 1
  operations.push((batch) => batch.update(snapshot.ref, { goal, strategyId, order }))
})

console.log(`Goals found: ${goals.join(', ') || '(none)'}`)
console.log(`Default strategies to create: ${strategiesToCreate}`)
console.log(`Settled idea records to assign or reorder: ${ideasToAssign}`)

if (!applyChanges) {
  console.log('Dry run only. Review the counts, then run: node migrate-ideate-strategies.mjs --apply')
} else {
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = writeBatch(db)
    operations.slice(offset, offset + 400).forEach((operation) => operation(batch))
    await batch.commit()
  }
  console.log('Strategy migration complete.')
}