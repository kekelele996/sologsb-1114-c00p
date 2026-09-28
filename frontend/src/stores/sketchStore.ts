import { createStore } from 'zustand/vanilla'
import type { Sketch, SketchContent, SketchDraft } from '@/types'
import { draftEqualsVersion, draftFromVersion, latestVersion } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

export interface SketchState {
  sketches: Sketch[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 保存草稿（不产生新版本，不参与拼合） */
  save: (id: string, segmentId: string, content: SketchContent) => Promise<Sketch>
  /** 签认：把当前草稿冻结成下一个版本 */
  sign: (id: string) => Promise<void>
  /** 放弃修图：草稿回到最新签认版本内容 */
  revert: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 拼合页上移/下移：互换两张草图的拼合顺序号（写入各自草稿与最新版本） */
  swapOrder: (idA: string, idB: string) => Promise<void>
}

/** 由内容字段计算草稿相对最新版本是否有改动 */
function isDirty(content: SketchContent, versions: Sketch['versions']): boolean {
  const latest = latestVersion({ versions })
  if (!latest) return true
  return !draftEqualsVersion(content, latest)
}

function toDraft(content: SketchContent, updatedAt: string): SketchDraft {
  return { ...content, updatedAt }
}

export const sketchStore = createStore<SketchState>((set, get) => ({
  sketches: [],
  loaded: false,
  hydrate: async () => {
    const sketches = await syncAll<Sketch>(db.sketches)
    // 拼合顺序以草稿中的顺序号为准
    sketches.sort((a, b) => a.draft.mergeOrder - b.draft.mergeOrder)
    set({ sketches, loaded: true })
  },
  save: async (id, segmentId, content) => {
    const now = new Date().toISOString()
    const existing = get().sketches.find((item) => item.id === id)
    const sketch: Sketch = existing
      ? {
          ...existing,
          segmentId,
          draft: toDraft(content, now),
          draftDirty: isDirty(content, existing.versions)
        }
      : {
          id,
          segmentId,
          draft: toDraft(content, now),
          versions: [],
          // 从未签认：草稿始终处于未签认状态
          draftDirty: true
        }
    await syncPut<Sketch>(db.sketches, sketch)
    await get().hydrate()
    return sketch
  },
  sign: async (id) => {
    const existing = get().sketches.find((item) => item.id === id)
    if (!existing) throw new Error('草图不存在，无法签认')
    const now = new Date().toISOString()
    const nextVersion = {
      ...existing.draft,
      version: existing.versions.length + 1,
      signedAt: now
    }
    const versions = [...existing.versions, nextVersion]
    const sketch: Sketch = {
      ...existing,
      versions,
      draft: { ...existing.draft, updatedAt: now },
      draftDirty: false
    }
    await syncPut<Sketch>(db.sketches, sketch)
    await get().hydrate()
  },
  revert: async (id) => {
    const existing = get().sketches.find((item) => item.id === id)
    const latest = existing ? latestVersion(existing) : null
    if (!existing || !latest) return
    const sketch: Sketch = {
      ...existing,
      draft: draftFromVersion(latest),
      draftDirty: false
    }
    await syncPut<Sketch>(db.sketches, sketch)
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete(db.sketches, id)
    await get().hydrate()
  },
  swapOrder: async (idA, idB) => {
    const all = get().sketches
    const a = all.find((item) => item.id === idA)
    const b = all.find((item) => item.id === idB)
    if (!a || !b) return
    const orderA = a.draft.mergeOrder
    const orderB = b.draft.mergeOrder
    const swap = (sketch: Sketch, order: number): Sketch => {
      const draft = { ...sketch.draft, mergeOrder: order }
      const versions = sketch.versions.map((version, index) =>
        index === sketch.versions.length - 1 ? { ...version, mergeOrder: order } : version
      )
      return { ...sketch, draft, versions }
    }
    await syncPut<Sketch>(db.sketches, swap(a, orderB))
    await syncPut<Sketch>(db.sketches, swap(b, orderA))
    await get().hydrate()
  }
}))
