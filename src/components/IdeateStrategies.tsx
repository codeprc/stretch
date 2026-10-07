import { useEffect, useState } from 'react'
import {
  createStarredIdeateStrategy,
  fetchStarredIdeateStrategies,
  fetchStarredIdeateStrategyIdeas,
  replaceStarredIdeateStrategyIdeas,
  restoreStarredIdeateStrategyIdea,
  saveStarredIdeateStrategyScroll,
  saveStarredIdeateStrategyName,
  saveStarredIdeateStrategyOrder,
  softDeleteStarredIdeateStrategyIdea,
} from '../firebase'
import type { StarredIdeateEntryRecord, StarredIdeateStrategyRecord } from '../firebase'
import { FormattedText } from './FormattedText'

interface IdeatePoolItem {
  id: string
  text: string
}

interface StrategyView extends StarredIdeateStrategyRecord {
  ideas: StarredIdeateEntryRecord[]
  deletedIdeas: StarredIdeateEntryRecord[]
}

interface IdeateStrategiesProps {
  goal: string
  ideas: IdeatePoolItem[]
}

const ideaColors = ['#4d9b78', '#d9a441', '#4d899b', '#bd6b83', '#c47b54', '#5a7ba0']
const DEFAULT_STRATEGY_NAME = 'Top Strategy'

export function IdeateStrategies({ goal, ideas: poolIdeas }: IdeateStrategiesProps) {
  const [strategies, setStrategies] = useState<StrategyView[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [showPrevious, setShowPrevious] = useState(true)
  const [showDeletedIdeas, setShowDeletedIdeas] = useState(false)
  const [editingStrategyId, setEditingStrategyId] = useState<string | null>(null)
  const [strategyNameDraft, setStrategyNameDraft] = useState('')
  const [editingIdeaId, setEditingIdeaId] = useState<string | null>(null)
  const [ideaTextDraft, setIdeaTextDraft] = useState('')
  const [linearStrategies, setLinearStrategies] = useState<Set<string>>(new Set())

  useEffect(() => {
    let active = true
    void fetchStarredIdeateStrategies(goal).then(async (records) => {
      const loaded = await Promise.all(records.map(async (strategy) => {
        const entries = await fetchStarredIdeateStrategyIdeas(goal, strategy.id, strategy.name, true)
        return {
          ...strategy,
          ideas: entries.filter((entry) => !entry.deletedOn),
          deletedIdeas: entries.filter((entry) => Boolean(entry.deletedOn)),
        }
      }))
      if (active) setStrategies(loaded)
    }).catch(() => {
      if (active) setLoadFailed(true)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [goal])

  const persistStrategyIdeas = async (strategyId: string, entries: StarredIdeateEntryRecord[]) => {
    const strategy = strategies.find((item) => item.id === strategyId)
    if (!strategy || !goal.trim()) return
    setStrategies((current) => current.map((item) => item.id === strategyId ? { ...item, ideas: entries } : item))
    await replaceStarredIdeateStrategyIdeas(goal, strategyId, entries.map((entry) => ({
      id: entry.id,
      ideaId: entry.ideaId,
      text: entry.text,
    })))
  }

  const saveIdeaText = async (strategy: StrategyView, idea: StarredIdeateEntryRecord, rawText = ideaTextDraft) => {
    const text = rawText.trim()
    setEditingIdeaId(null)
    if (!text || text === idea.text) return
    await persistStrategyIdeas(strategy.id, strategy.ideas.map((entry) => entry.id === idea.id ? { ...entry, text } : entry))
  }

  const addStrategy = async () => {
    const normalizedGoal = goal.trim()
    if (!normalizedGoal || loading) return
    const name = `Strategy ${strategies.filter((strategy) => strategy.name !== DEFAULT_STRATEGY_NAME).length + 1}`
    const id = await createStarredIdeateStrategy(normalizedGoal, name, strategies.length)
    if (!id) return
    setStrategies((current) => [...current, { id, goal: normalizedGoal, name, order: current.length, createdAt: new Date().toISOString(), scrollAfterFive: true, ideas: [], deletedIdeas: [] }])
    setShowPrevious(true)
  }

  const saveStrategyName = async (strategy: StrategyView) => {
    const name = strategyNameDraft.trim()
    setEditingStrategyId(null)
    if (!name || name === strategy.name) return
    try {
      await saveStarredIdeateStrategyName(strategy.id, name)
      setStrategies((current) => current.map((item) => item.id === strategy.id ? { ...item, name } : item))
    } catch {
      setStrategyNameDraft(strategy.name)
    }
  }

  const setStrategyScrollAfterFive = async (strategy: StrategyView, enabled: boolean) => {
    await saveStarredIdeateStrategyScroll(strategy.id, enabled)
    setStrategies((current) => current.map((item) => item.id === strategy.id ? { ...item, scrollAfterFive: enabled } : item))
  }

  const removeStrategyIdea = async (strategyId: string, idea: StarredIdeateEntryRecord) => {
    await softDeleteStarredIdeateStrategyIdea(idea.id)
    setStrategies((current) => current.map((strategy) => strategy.id === strategyId
      ? { ...strategy, ideas: strategy.ideas.filter((entry) => entry.id !== idea.id), deletedIdeas: [...strategy.deletedIdeas, { ...idea, deletedOn: new Date().toISOString() }] }
      : strategy))
  }

  const restoreStrategyIdea = async (strategyId: string, idea: StarredIdeateEntryRecord) => {
    await restoreStarredIdeateStrategyIdea(idea.id)
    setStrategies((current) => current.map((strategy) => {
      if (strategy.id !== strategyId) return strategy
      const ideas = [...strategy.ideas]
      ideas.splice(Math.min(idea.order, ideas.length), 0, { ...idea, deletedOn: null })
      return { ...strategy, ideas, deletedIdeas: strategy.deletedIdeas.filter((entry) => entry.id !== idea.id) }
    }))
  }

  const reorderStrategies = async (sourceId: string, targetIndex: number) => {
    const sourceIndex = strategies.findIndex((strategy) => strategy.id === sourceId)
    if (sourceIndex < 0) return
    const next = [...strategies]
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, moved)
    setStrategies(next.map((strategy, order) => ({ ...strategy, order })))
    await saveStarredIdeateStrategyOrder(goal, next.map((strategy) => strategy.id))
  }

  const handleIdeaDrop = (strategyId: string, targetIndex: number, dataTransfer: DataTransfer) => {
    const draggedStrategyId = dataTransfer.getData('application/x-ideate-strategy')
    if (draggedStrategyId) return

    const target = strategies.find((strategy) => strategy.id === strategyId)
    if (!target) return

    const membershipId = dataTransfer.getData('application/x-ideate-membership')
    if (membershipId) {
      const sourceStrategyId = dataTransfer.getData('application/x-ideate-source-strategy')
      const sourceStrategy = strategies.find((strategy) => strategy.id === sourceStrategyId)
      const sourceIndex = sourceStrategy?.ideas.findIndex((idea) => idea.id === membershipId) ?? -1
      if (!sourceStrategy || sourceIndex < 0) return
      const sourceIdea = sourceStrategy.ideas[sourceIndex]

      if (sourceStrategyId === strategyId) {
        const next = [...target.ideas]
        const [moved] = next.splice(sourceIndex, 1)
        next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, moved)
        void persistStrategyIdeas(strategyId, next)
        return
      }

      const copy = { ...sourceIdea, id: `entry-${crypto.randomUUID()}`, strategyId }
      const next = [...target.ideas]
      next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, copy)
      void persistStrategyIdeas(strategyId, next)
      return
    }

    const sourceIdea = poolIdeas.find((idea) => idea.id === dataTransfer.getData('text/plain'))
    if (!sourceIdea) return
    const entry: StarredIdeateEntryRecord = {
      id: `entry-${crypto.randomUUID()}`,
      goal: goal.trim(),
      strategyId,
      ideaId: sourceIdea.id,
      text: sourceIdea.text,
      order: targetIndex,
      createdAt: new Date().toISOString(),
    }
    const next = [...target.ideas]
    next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, entry)
    void persistStrategyIdeas(strategyId, next)
  }

  const addIdeaAt = async (strategy: StrategyView, position: 'front' | 'back', insertIndex?: number) => {
    const text = window.prompt(position === 'front' ? 'New idea before this arrow' : 'New idea after this arrow')?.trim()
    if (!text) return
    const entry: StarredIdeateEntryRecord = {
      id: `entry-${crypto.randomUUID()}`,
      goal: goal.trim(),
      strategyId: strategy.id,
      ideaId: `idea-${crypto.randomUUID()}`,
      text,
      order: insertIndex ?? (position === 'front' ? 0 : strategy.ideas.length),
      createdAt: new Date().toISOString(),
    }
    const index = insertIndex ?? (position === 'front' ? 0 : strategy.ideas.length)
    const next = [...strategy.ideas]
    next.splice(index, 0, entry)
    await persistStrategyIdeas(strategy.id, next)
  }

  const visibleStrategies = showPrevious ? strategies : strategies.slice(-1)

  return <section id="ideate-chain" className="ideate-strategies" aria-label="Strategies">
    <div className="ideate-strategies-header">
      <h3>Strategies</h3>
      <div className="ideate-strategy-actions">
        <button className="goal-manager-button" type="button" disabled={!goal.trim() || loading} onClick={() => void addStrategy()}>Add more strategy</button>
        {strategies.length > 1 && <button className="goal-manager-button" type="button" aria-expanded={showPrevious} onClick={() => setShowPrevious((shown) => !shown)}>{showPrevious ? 'Hide previous strategies' : 'Show previous strategies'}</button>}
        {strategies.some((strategy) => strategy.deletedIdeas.length > 0) && <button className="goal-manager-button" type="button" aria-expanded={showDeletedIdeas} onClick={() => setShowDeletedIdeas((shown) => !shown)}>{showDeletedIdeas ? 'Hide removed arrows' : 'Show removed arrows'}</button>}
      </div>
    </div>
    {!goal.trim() ? <p className="ideate-chain-empty">Star a goal to manage its strategies</p> : loadFailed ? <p className="ideate-chain-empty">Could not load strategies</p> : loading ? <p className="ideate-chain-empty">Loading strategies...</p> : <div className="ideate-strategy-list">
      {visibleStrategies.map((strategy, index) => <article id={`ideate-strategy-${strategy.id}`} className="ideate-strategy" key={strategy.id} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}>
        <header className="ideate-strategy-header" draggable={editingStrategyId !== strategy.id} onDragStart={(event) => { event.dataTransfer.setData('application/x-ideate-strategy', strategy.id); event.dataTransfer.effectAllowed = 'move' }} onDrop={(event) => { const sourceId = event.dataTransfer.getData('application/x-ideate-strategy'); if (sourceId) { event.preventDefault(); event.stopPropagation(); void reorderStrategies(sourceId, index) } }}>
          <button className="strategy-layout-toggle" type="button" aria-label={`Switch ${strategy.name} layout`} aria-pressed={linearStrategies.has(strategy.id)} title="Toggle arrow or boxed row layout" onClick={() => setLinearStrategies((current) => { const next = new Set(current); if (next.has(strategy.id)) next.delete(strategy.id); else next.add(strategy.id); return next })}>▤</button>
          <label className="strategy-scroll-setting"><input type="checkbox" checked={strategy.scrollAfterFive} aria-label={`Enable scrolling after five arrows in ${strategy.name}`} onChange={(event) => void setStrategyScrollAfterFive(strategy, event.target.checked)} /><span>Scroll after 5</span></label>
          <span className="ideate-strategy-grip" aria-hidden="true">⋮⋮</span>{editingStrategyId === strategy.id ? <input className="ideate-strategy-name-input" autoFocus value={strategyNameDraft} onChange={(event) => setStrategyNameDraft(event.target.value)} onBlur={() => void saveStrategyName(strategy)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} aria-label="Strategy name" /> : <h4 className={strategy.name === DEFAULT_STRATEGY_NAME ? undefined : 'editable-strategy-name'} title={strategy.name === DEFAULT_STRATEGY_NAME ? undefined : 'Double-click to rename'} onDoubleClick={() => { if (strategy.name !== DEFAULT_STRATEGY_NAME) { setStrategyNameDraft(strategy.name); setEditingStrategyId(strategy.id) } }} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && strategy.name !== DEFAULT_STRATEGY_NAME) { event.preventDefault(); setStrategyNameDraft(strategy.name); setEditingStrategyId(strategy.id) } }} tabIndex={strategy.name === DEFAULT_STRATEGY_NAME ? undefined : 0}><FormattedText text={strategy.name} /></h4>}<span className="ideate-strategy-goal"><FormattedText text={goal} /></span>
        </header>
        <div className={`ideate-chain-row${linearStrategies.has(strategy.id) ? ' linear-layout' : ''}${strategy.scrollAfterFive && strategy.ideas.length > 5 ? ' scroll-after-five' : ''}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); handleIdeaDrop(strategy.id, strategy.ideas.length, event.dataTransfer) }}>
          {strategy.ideas.map((idea, ideaIndex) => {
            const isEditingIdea = editingIdeaId === idea.id
            return <div className="ideate-arrow-group" key={idea.id}>
              <button className="ideate-edge-plus" type="button" aria-label={`Add idea before ${idea.text}`} title="Add idea before" onClick={() => void addIdeaAt(strategy, 'front', ideaIndex)}>+</button>
              <div id={`ideate-arrow-${idea.id}`} className="ideate-chain-item" style={{ background: ideaColors[ideaIndex % ideaColors.length] }} draggable={!isEditingIdea} tabIndex={0} aria-label={`${idea.text}. Double-click to edit; press Backspace to remove from ${strategy.name}`} onClick={(event) => event.currentTarget.focus()} onDoubleClick={(event) => { event.stopPropagation(); setIdeaTextDraft(idea.text); setEditingIdeaId(idea.id) }} onKeyDown={(event) => {
                if (event.key !== 'Backspace') return
                event.preventDefault()
                void removeStrategyIdea(strategy.id, idea)
              }} onDragStart={(event) => { event.dataTransfer.setData('application/x-ideate-membership', idea.id); event.dataTransfer.setData('application/x-ideate-source-strategy', strategy.id); event.dataTransfer.effectAllowed = 'move' }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); handleIdeaDrop(strategy.id, ideaIndex, event.dataTransfer) }}>
                {isEditingIdea ? <input className="ideate-arrow-text-input" autoFocus value={ideaTextDraft} aria-label="Update arrow text" onChange={(event) => setIdeaTextDraft(event.target.value)} onBlur={() => void saveIdeaText(strategy, idea)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setIdeaTextDraft(idea.text); setEditingIdeaId(null) } }} /> : <span><FormattedText text={idea.text} /></span>}
                <button className="ideate-arrow-remove" type="button" aria-label={`Remove ${idea.text} from ${strategy.name}`} title="Remove from strategy" onClick={(event) => { event.stopPropagation(); void removeStrategyIdea(strategy.id, idea) }}>-</button>
              </div>
              <button className="ideate-edge-plus" type="button" aria-label={`Add idea after ${idea.text}`} title="Add idea after" onClick={() => void addIdeaAt(strategy, 'back', ideaIndex + 1)}>+</button>
            </div>
          })}
          {!strategy.ideas.length && <><div className="ideate-chain-empty">Drop ideas here to build this strategy</div><button className="ideate-edge-plus" type="button" aria-label={`Add idea to ${strategy.name}`} title="Add idea" onClick={() => void addIdeaAt(strategy, 'back')}>+</button></>}
          <button className="ideate-edge-plus" type="button" aria-label={`Add idea to front of ${strategy.name}`} title="Add idea at front" onClick={() => void addIdeaAt(strategy, 'front')}>+</button>
        </div>
        {showDeletedIdeas && strategy.deletedIdeas.length > 0 && <div className="ideate-deleted-list"><h5>Removed arrows</h5>{strategy.deletedIdeas.map((idea) => <div className="ideate-deleted-item" key={`removed-${idea.id}`}><span><FormattedText text={idea.text} /></span><button className="goal-manager-button" type="button" onClick={() => void restoreStrategyIdea(strategy.id, idea)}>Restore</button></div>)}</div>}
      </article>)}
    </div>}
  </section>
}