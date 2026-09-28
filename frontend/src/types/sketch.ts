/** 草图内容（草稿与签认版本共用的字段） */
export interface SketchContent {
  /** 坐标纸格数 */
  gridCount: number
  /** 缩放比例（1:N 的 N，如 200 表示 1:200） */
  scale: number
  /** 绘制人 */
  author: string
  /** 桩号对齐锚点 */
  anchorStake: string
  /** 图片数据说明 */
  imageNote: string
}

/** 未签认草稿：可继续修改，但不参与图幅拼合 */
export interface SketchDraft extends SketchContent {
  /** 草稿保存时间（ISO 字符串） */
  updatedAt: string
}

/** 已签认版本：内容冻结，只可查看 */
export interface SketchVersion extends SketchContent {
  /** 版本号，从 1 起单调递增 */
  version: number
  /** 签认时间（ISO 字符串） */
  signedAt: string
}

/** Sketch 草图：一张草图由若干冻结版本与至多一份未签认草稿组成 */
export interface Sketch {
  id: string
  segmentId: string
  /** 草图编号 */
  code: string
  /** 图幅拼合顺序号 */
  mergeOrder: number
  /** 已签认版本，按版本号升序 */
  versions: SketchVersion[]
  /** 未签认草稿：存在即表示现场修订尚未签认 */
  draft: SketchDraft | null
}

/** 图幅拼合对齐结果 */
export interface MergeItem {
  sketchId: string
  /** 对齐后的横向偏移（单位：格） */
  offset: number
  /** 是否已吸附到锚点 */
  snapped: boolean
}

/** 草图当前状态 */
export type SketchStatus = 'draft-only' | 'signed' | 'revising'

/** 计算草图状态：仅草稿 / 最新已签认 / 签认后又有草稿在修 */
export function sketchStatus(sketch: Pick<Sketch, 'versions' | 'draft'>): SketchStatus {
  if (sketch.versions.length === 0) return 'draft-only'
  return sketch.draft ? 'revising' : 'signed'
}

/** 是否已有可参与拼合的签认版本 */
export function isSigned(sketch: Pick<Sketch, 'versions'>): boolean {
  return sketch.versions.length > 0
}

/** 最新签认版本（无则为 null） */
export function latestVersion(sketch: Sketch): SketchVersion | null {
  return sketch.versions.length > 0 ? sketch.versions[sketch.versions.length - 1] : null
}

/** 工作台当前展示/编辑的内容：优先草稿，否则取最新签认版本 */
export function activeContent(sketch: Sketch): SketchContent | null {
  return sketch.draft ?? latestVersion(sketch)
}
