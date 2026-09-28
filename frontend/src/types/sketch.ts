/** 草图内容字段（草稿与签认版本共用的形状） */
export interface SketchContent {
  /** 草图编号 */
  code: string
  /** 坐标纸格数 */
  gridCount: number
  /** 缩放比例（1:N 的 N，如 200 表示 1:200） */
  scale: number
  /** 绘制人 */
  author: string
  /** 图幅拼合顺序号 */
  mergeOrder: number
  /** 桩号对齐锚点 */
  anchorStake: string
  /** 图片数据说明 */
  imageNote: string
}

/**
 * 未签认草稿：可继续修改，不参与图幅拼合。
 * 签认后草稿仍保留一份与最新版本一致的干净副本，修图从这份新草稿开始。
 */
export interface SketchDraft extends SketchContent {
  /** 草稿最近一次保存时间（ISO 字符串） */
  updatedAt: string
}

/** 签认时冻结下来的版本快照，之后不可修改 */
export interface SketchVersion extends SketchContent {
  /** 版本号，从 1 开始逐次签认递增 */
  version: number
  /** 签认时间（ISO 字符串）；v3 迁移的历史数据为空串 */
  signedAt: string
}

/** Sketch 草图：一张草图 = 一份草稿 + 若干已签认版本 */
export interface Sketch {
  id: string
  segmentId: string
  /** 可继续修改的草稿内容 */
  draft: SketchDraft
  /** 已签认版本，按版本号升序；为空表示从未签认 */
  versions: SketchVersion[]
  /** 草稿是否相对最新签认版本有改动（从未签认恒为 true） */
  draftDirty: boolean
}

/** 草图业务状态 */
export type SketchStatus = 'draft' | 'revising' | 'signed'

/** 最新已签认版本；从未签认返回 null */
export function latestVersion(sketch: Pick<Sketch, 'versions'>): SketchVersion | null {
  return sketch.versions.length > 0 ? sketch.versions[sketch.versions.length - 1] : null
}

/** 草稿内容与某版本是否一致（用于判断修图后是否真的有改动） */
export function draftEqualsVersion(draft: SketchContent, version: SketchContent): boolean {
  return (
    draft.code === version.code &&
    draft.gridCount === version.gridCount &&
    draft.scale === version.scale &&
    draft.author === version.author &&
    draft.mergeOrder === version.mergeOrder &&
    draft.anchorStake === version.anchorStake &&
    draft.imageNote === version.imageNote
  )
}

/**
 * 业务状态：
 * - draft：从未签认的草稿
 * - revising：已有签认版本，草稿改动待签认
 * - signed：草稿与最新版本一致，当前内容已签认
 */
export function sketchStatus(sketch: Sketch): SketchStatus {
  const latest = latestVersion(sketch)
  if (!latest) return 'draft'
  return sketch.draftDirty || !draftEqualsVersion(sketch.draft, latest) ? 'revising' : 'signed'
}

/** 是否存在未签认草稿（从未签认，或签认后又改过）；此类草图禁止桩号吸附 */
export function hasPendingDraft(sketch: Sketch): boolean {
  return sketchStatus(sketch) !== 'signed'
}

/** 以某版本内容生成一份新草稿（放弃修图时回到签认时的内容） */
export function draftFromVersion(version: SketchVersion): SketchDraft {
  return {
    code: version.code,
    gridCount: version.gridCount,
    scale: version.scale,
    author: version.author,
    mergeOrder: version.mergeOrder,
    anchorStake: version.anchorStake,
    imageNote: version.imageNote,
    updatedAt: version.signedAt
  }
}

/** 图幅拼合对齐结果 */
export interface MergeItem {
  sketchId: string
  /** 对齐后的横向偏移（单位：格） */
  offset: number
  /** 是否已吸附到锚点 */
  snapped: boolean
}
