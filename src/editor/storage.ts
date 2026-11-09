// Editor drafts in localStorage: one key per draft plus an index.

import { emptyLevel, type LevelPack } from '../levels/format'

export type Draft = {
  id: string
  pack: LevelPack
  updated: number
  /** store id once published from this draft */
  storeId?: string
}

const INDEX = 'tanks.editor.drafts'
const CURRENT = 'tanks.editor.current'
const key = (id: string) => `tanks.editor.draft.${id}`

function read<T>(k: string, fallback: T): T {
  try {
    const s = localStorage.getItem(k)
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}

export function draftIds(): string[] {
  return read<string[]>(INDEX, [])
}

export function listDrafts(): Draft[] {
  return draftIds()
    .map((id) => read<Draft | null>(key(id), null))
    .filter((d): d is Draft => !!d && !!d.pack?.levels?.length)
    .sort((a, b) => b.updated - a.updated)
}

export function loadDraft(id: string): Draft | null {
  return read<Draft | null>(key(id), null)
}

/** false when storage is full */
export function saveDraft(d: Draft): boolean {
  d.updated = Date.now()
  try {
    localStorage.setItem(key(d.id), JSON.stringify(d))
    const ids = draftIds()
    if (!ids.includes(d.id)) localStorage.setItem(INDEX, JSON.stringify([...ids, d.id]))
    return true
  } catch {
    return false
  }
}

export function deleteDraft(id: string) {
  localStorage.removeItem(key(id))
  localStorage.setItem(INDEX, JSON.stringify(draftIds().filter((x) => x !== id)))
  if (currentDraft() === id) localStorage.removeItem(CURRENT)
}

export function currentDraft(): string | null {
  return localStorage.getItem(CURRENT)
}
export function setCurrentDraft(id: string) {
  localStorage.setItem(CURRENT, id)
}

export function newDraftId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export function newDraft(pack?: LevelPack): Draft {
  return { id: newDraftId(), updated: Date.now(), pack: pack ?? { v: 1, name: 'My level pack', lives: 3, levels: [emptyLevel('Level 1')] } }
}
