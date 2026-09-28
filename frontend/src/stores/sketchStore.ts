import { createStore } from 'zustand/vanilla'
import type { Sketch, SketchContent } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

function newSketchId(): string {
  return `sk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface SketchState {
  sketches: Sketch[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 保存草稿（新建草图或更新已有草稿）；草稿可继续修改但不参与拼合 */
  saveDraft: (input: {
    id?: string
    segmentId: string
    code: string
    mergeOrder: number
    content: SketchContent
  }) => Promise<string>
  /** 签认：把当前草稿冻结成新版本，记录版本号/绘制人/签认时间，随后从新草稿继续修 */
  signOff: (id: string) => Promise<void>
  /** 丢弃未签认草稿，回到最新签认版本（仅草稿草图等同删除） */
  discardDraft: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (orderedIds: string[]) => Promise<void>
}

function toDraft(content: SketchContent, updatedAt: string): Sketch['draft'] {
  return { ...content, updatedAt }
}

export const sketchStore = createStore<SketchState>((set, get) => ({
  sketches: [],
  loaded: false,
  hydrate: async () => {
    const sketches = await syncAll<Sketch>(db.sketches)
    sketches.sort((a, b) => a.mergeOrder - b.mergeOrder)
    set({ sketches, loaded: true })
  },
  saveDraft: async ({ id, segmentId, code, mergeOrder, content }) => {
    const existing = id ? get().sketches.find((item) => item.id === id) : undefined
    const now = new Date().toISOString()
    let sketch: Sketch
    let sketchId: string
    if (existing) {
      sketch = {
        ...existing,
        code,
        mergeOrder,
        draft: toDraft(content, now)
      }
      sketchId = existing.id
    } else {
      sketchId = newSketchId()
      sketch = {
        id: sketchId,
        segmentId,
        code,
        mergeOrder,
        versions: [],
        draft: toDraft(content, now)
      }
    }
    await syncPut<Sketch>(db.sketches, sketch)
    await get().hydrate()
    return sketchId
  },
  signOff: async (id) => {
    const existing = get().sketches.find((item) => item.id === id)
    if (!existing) throw new Error('草图不存在，无法签认')
    if (!existing.draft) throw new Error('没有未签认草稿，无需签认')
    const version = {
      ...existing.draft,
      version: existing.versions.length + 1,
      signedAt: new Date().toISOString()
    }
    const next: Sketch = {
      ...existing,
      versions: [...existing.versions, version],
      draft: null
    }
    await syncPut<Sketch>(db.sketches, next)
    await get().hydrate()
  },
  discardDraft: async (id) => {
    const existing = get().sketches.find((item) => item.id === id)
    if (!existing || !existing.draft) return
    if (existing.versions.length === 0) {
      await syncDelete(db.sketches, id)
    } else {
      await syncPut<Sketch>(db.sketches, { ...existing, draft: null })
    }
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete(db.sketches, id)
    await get().hydrate()
  },
  reorder: async (orderedIds) => {
    // 仅重排参与拼合的已签认图幅；未签认草稿保留在原槽位，不被挤出顺序
    const all = get().sketches.slice().sort((a, b) => a.mergeOrder - b.mergeOrder)
    const movableIds = new Set(orderedIds)
    const newOrders = new Map<string, number>()
    let movableIndex = 0
    all.forEach((item, rank) => {
      if (movableIds.has(item.id)) {
        newOrders.set(orderedIds[movableIndex], rank + 1)
        movableIndex += 1
      } else {
        newOrders.set(item.id, rank + 1)
      }
    })
    await Promise.all(
      all.map((item) =>
        syncPut<Sketch>(db.sketches, { ...item, mergeOrder: newOrders.get(item.id) ?? item.mergeOrder })
      )
    )
    await get().hydrate()
  }
}))
