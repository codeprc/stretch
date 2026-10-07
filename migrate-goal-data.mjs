import { initializeApp } from 'firebase/app'
import { collection, deleteField, doc, getDocs, getFirestore, writeBatch } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyAjayg8hqM-LdC3G2g2oFu-SAePxpakAAQ',
  authDomain: 'stretch-codeprc.firebaseapp.com',
  projectId: 'stretch-codeprc',
  storageBucket: 'stretch-codeprc.firebasestorage.app',
  messagingSenderId: '631508117938',
  appId: '1:631508117938:web:884920cbd7e2066b5ddcab',
}

const goalName = 'MSE - Daily 10 Tasks of Each'
const applyChanges = process.argv.includes('--apply')
const db = getFirestore(initializeApp(firebaseConfig))
const [starredSnapshot, skillsSnapshot, ideasSnapshot] = await Promise.all([
  getDocs(collection(db, 'starred')),
  getDocs(collection(db, 'starred_skill')),
  getDocs(collection(db, 'starred_ideate')),
])

const readGoalNames = (data) => {
  const values = Array.isArray(data.items) ? data.items : [data.item ?? data.items]
  return values.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
}

const existingGoals = [...new Set(starredSnapshot.docs.flatMap((snapshot) => readGoalNames(snapshot.data())))]
const existingTarget = starredSnapshot.docs.find((snapshot) => readGoalNames(snapshot.data()).includes(goalName))
const targetRef = existingTarget?.ref ?? doc(collection(db, 'starred'))
const operations = []
const updatedAt = new Date().toISOString()

if (existingTarget) {
  operations.push((batch) => batch.update(targetRef, {
    item: goalName,
    items: deleteField(),
    active: true,
    updatedAt,
  }))
} else {
  operations.push((batch) => batch.set(targetRef, {
    item: goalName,
    active: true,
    createdAt: updatedAt,
    updatedAt,
  }))
}

starredSnapshot.docs.forEach((snapshot) => {
  if (snapshot.id !== targetRef.id) operations.push((batch) => batch.delete(snapshot.ref))
})

const seenSkillIds = new Set()
let migratedSkills = 0
let duplicateSkills = 0
skillsSnapshot.docs.forEach((snapshot) => {
  const data = snapshot.data()
  const skillKey = String(data.skillId || data.skillName || snapshot.id)
  if (seenSkillIds.has(skillKey)) {
    duplicateSkills += 1
    operations.push((batch) => batch.delete(snapshot.ref))
    return
  }
  seenSkillIds.add(skillKey)
  if (data.item !== goalName) migratedSkills += 1
  operations.push((batch) => batch.update(snapshot.ref, { item: goalName }))
})

const sortedIdeas = ideasSnapshot.docs
  .map((snapshot) => ({ snapshot, data: snapshot.data() }))
  .sort((first, second) => (Number(first.data.order) || 0) - (Number(second.data.order) || 0)
    || String(first.data.createdAt || '').localeCompare(String(second.data.createdAt || '')))
const seenIdeaIds = new Set()
let migratedIdeas = 0
let duplicateIdeas = 0
let ideaOrder = 0
sortedIdeas.forEach(({ snapshot, data }) => {
  const ideaKey = String(data.ideaId || snapshot.id)
  if (seenIdeaIds.has(ideaKey)) {
    duplicateIdeas += 1
    operations.push((batch) => batch.delete(snapshot.ref))
    return
  }
  seenIdeaIds.add(ideaKey)
  if (data.goal !== goalName) migratedIdeas += 1
  operations.push((batch) => batch.update(snapshot.ref, { goal: goalName, order: ideaOrder++ }))
})

console.log(`Existing goals: ${existingGoals.length ? existingGoals.join(', ') : '(none)'}`)
console.log(`Goal records to remove: ${Math.max(0, starredSnapshot.size - (existingTarget ? 1 : 0))}`)
console.log(`Skill mappings to move: ${migratedSkills}; duplicate mappings to remove: ${duplicateSkills}`)
console.log(`Settled ideas to move: ${migratedIdeas}; duplicate ideas to remove: ${duplicateIdeas}`)

if (!applyChanges) {
  console.log('Dry run only. Review the counts, then run: node migrate-goal-data.mjs --apply')
} else {
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = writeBatch(db)
    operations.slice(offset, offset + 400).forEach((operation) => operation(batch))
    await batch.commit()
  }
  console.log(`Migration complete. Only "${goalName}" remains and is active.`)
}