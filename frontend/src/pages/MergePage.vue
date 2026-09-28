<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { Sketch, SketchVersion } from '@/types'
import { hasPendingDraft, latestVersion } from '@/types'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import GridCanvas from '@/components/common/GridCanvas.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { downloadCsv } from '@/utils/export'
import { stakeToNumber } from '@/utils/survey'

const CANVAS_W = 780
const CANVAS_H = 300
const SNAP_PX = 12
const PX_PER_METER = 1.6

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const draggingId = ref<string | null>(null)
const dragStartX = ref(0)
const dragOriginOffset = ref(0)
const snapLog = ref<string[]>([])

const offsets = reactive<Record<string, number>>({})
const snapped = reactive<Record<string, boolean>>({})

const caveSegments = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)

/** 本洞穴下的全部草图 */
const caveSketches = computed<Sketch[]>(() =>
  sketchState.sketches
    .filter((sketch) => caveSegments.value.some((segment) => segment.id === sketch.segmentId))
    .sort((a, b) => a.draft.mergeOrder - b.draft.mergeOrder)
)

/** 可参与拼合的图幅：取每张草图的最新已签认版本 */
interface SignedSheet {
  sketch: Sketch
  version: SketchVersion
}

const signedSheets = computed<SignedSheet[]>(() =>
  caveSketches.value.flatMap((sketch) => {
    const version = latestVersion(sketch)
    return version ? [{ sketch, version }] : []
  })
)

/** 未签认草稿：桩号吸附必须在此为空时才允许执行 */
const pendingDrafts = computed(() => caveSketches.value.filter((sketch) => hasPendingDraft(sketch)))

function segmentOf(sketch: Sketch): string {
  const segment = segmentState.segments.find((item) => item.id === sketch.segmentId)
  return segment ? segment.code : '未归属'
}

function widthOf(version: SketchVersion): number {
  return Math.max(88, Math.round(version.gridCount * (200 / Math.max(10, version.scale)) * 4))
}

const totalWidth = computed(() =>
  signedSheets.value.reduce((sum, sheet) => sum + widthOf(sheet.version) + 10, 0)
)

// IndexedDB 异步水合完成后自动选中第一条洞穴
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

watch(
  signedSheets,
  (list) => {
    list.forEach((sheet) => {
      if (offsets[sheet.sketch.id] === undefined) offsets[sheet.sketch.id] = 0
      if (snapped[sheet.sketch.id] === undefined) snapped[sheet.sketch.id] = false
    })
  },
  { immediate: true }
)

/** 洞段测点闭合差（拼合视图复用闭合差徽标） */
const caveStations = computed(() =>
  stationState.stations.filter((station) =>
    caveSegments.value.some((segment) => segment.id === station.segmentId)
  )
)
const { result: closureResult } = useClosureCheck(caveStations)

function describePending(sketch: Sketch): string {
  const latest = latestVersion(sketch)
  const note = latest ? `最新签认 V${latest.version}，草稿改动未签认` : '尚未签认过'
  return `${sketch.draft.code}（洞段 ${segmentOf(sketch)}，${note}）`
}

/** 按桩号锚点自动吸附：以最小锚点桩号为原点，按桩号差换算横向偏移 */
function autoAlign(): void {
  // 同一洞穴存在未签认草稿时必须停下，已签认图幅仍照常显示
  if (pendingDrafts.value.length > 0) {
    const names = pendingDrafts.value.map(describePending)
    snapLog.value = names.map((name) => `已拦截：${name}，签认或放弃改动后才能按桩号吸附`)
    ElMessage({
      type: 'error',
      message: `桩号吸附已中止：以下 ${names.length} 张草图有未签认草稿 —— ${names.join('；')}`,
      duration: 6000,
      showClose: true
    })
    return
  }
  const list = signedSheets.value
  if (list.length === 0) {
    ElMessage.warning('当前洞穴暂无可拼合的已签认图幅')
    return
  }
  const base = Math.min(...list.map((sheet) => stakeToNumber(sheet.version.anchorStake)))
  const logs: string[] = []
  list.forEach((sheet) => {
    const stake = stakeToNumber(sheet.version.anchorStake)
    const target = Math.round((stake - base) * PX_PER_METER)
    offsets[sheet.sketch.id] = target
    snapped[sheet.sketch.id] = true
    logs.push(`${sheet.version.code} V${sheet.version.version} 锚点 ${sheet.version.anchorStake} → 偏移 ${target}px`)
  })
  snapLog.value = logs
  ElMessage.success(`已按桩号锚点吸附 ${list.length} 张图幅`)
}

function onMouseDown(sheet: SignedSheet, event: MouseEvent): void {
  draggingId.value = sheet.sketch.id
  dragStartX.value = event.clientX
  dragOriginOffset.value = offsets[sheet.sketch.id] ?? 0
}

function onMouseMove(event: MouseEvent): void {
  if (!draggingId.value) return
  const delta = event.clientX - dragStartX.value
  const raw = Math.max(-200, Math.min(CANVAS_W - 60, dragOriginOffset.value + delta))
  const list = signedSheets.value
  const index = list.findIndex((sheet) => sheet.sketch.id === draggingId.value)
  let value = Math.round(raw)
  let snapTarget: string | null = null
  const others = list.filter((sheet) => sheet.sketch.id !== draggingId.value)
  for (const other of others) {
    const otherRight = (offsets[other.sketch.id] ?? 0) + widthOf(other.version)
    if (Math.abs(value - otherRight) <= SNAP_PX) {
      value = otherRight
      snapTarget = `${other.version.code} V${other.version.version}`
      break
    }
  }
  offsets[draggingId.value] = value
  snapped[draggingId.value] = snapTarget !== null
  if (snapTarget) {
    const current = list[index]
    snapLog.value = [`${current.version.code} V${current.version.version} 吸附到 ${snapTarget} 右边缘（偏移 ${value}px）`]
  }
}

function onMouseUp(): void {
  draggingId.value = null
}

/** 拼合顺序表（输出结果） */
interface MergeRow {
  order: number
  code: string
  version: number
  segment: string
  author: string
  anchorStake: string
  offset: number
  snapped: boolean
  sketchId: string
}

const mergeRows = computed<MergeRow[]>(() =>
  signedSheets.value.map((sheet, index) => ({
    order: index + 1,
    code: sheet.version.code,
    version: sheet.version.version,
    segment: segmentOf(sheet.sketch),
    author: sheet.version.author,
    anchorStake: sheet.version.anchorStake,
    offset: offsets[sheet.sketch.id] ?? 0,
    snapped: snapped[sheet.sketch.id] ?? false,
    sketchId: sheet.sketch.id
  }))
)

async function move(index: number, direction: -1 | 1): Promise<void> {
  const list = signedSheets.value
  const target = index + direction
  if (target < 0 || target >= list.length) return
  await sketchStore.getState().swapOrder(list[index].sketch.id, list[target].sketch.id)
}

function exportMergeTable(): void {
  downloadCsv(
    '图幅拼合顺序表.csv',
    mergeRows.value as unknown as Record<string, unknown>[],
    [
      { key: 'order', label: '拼合顺序' },
      { key: 'code', label: '草图编号' },
      { key: 'version', label: '签认版本' },
      { key: 'segment', label: '洞段' },
      { key: 'author', label: '绘制人' },
      { key: 'anchorStake', label: '锚点桩号' },
      { key: 'offset', label: '对齐偏移(px)' },
      { key: 'snapped', label: '是否吸附' }
    ]
  )
  ElMessage.success('拼合顺序表已导出')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">图幅拼合视图</h2>
        <p class="page-sub">
          仅已签认图幅参与拼合；存在未签认草稿时「按桩号锚点吸附」会中止并点名草图，已签认图幅仍可拖动查看。下方输出拼合顺序表。
        </p>
      </div>
      <div class="head-actions">
        <el-button type="primary" @click="autoAlign">按桩号锚点吸附对齐</el-button>
        <el-button @click="exportMergeTable">导出拼合顺序表</el-button>
      </div>
    </div>

    <el-alert
      v-if="pendingDrafts.length > 0"
      class="pending-alert"
      type="error"
      show-icon
      :closable="false"
      title="同一洞段存在未签认草稿，桩号吸附已被拦下"
    >
      <ul class="pending-list">
        <li v-for="sketch in pendingDrafts" :key="sketch.id">
          <el-link type="danger" :underline="false" @click="$router.push('/sketch')">
            {{ describePending(sketch) }}
          </el-link>
        </li>
      </ul>
      <span class="pending-hint">请到「草图工作台」签认或放弃修图；其余已签认图幅在下方照常显示与拖动。</span>
    </el-alert>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 220px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-tag effect="plain">已签认图幅 {{ signedSheets.length }} 张</el-tag>
      <el-tag type="warning" effect="plain" v-if="pendingDrafts.length > 0">
        未签认草稿 {{ pendingDrafts.length }} 张
      </el-tag>
      <el-tag effect="plain">总宽 {{ totalWidth }} px</el-tag>
      <div class="seg-tags">
        <SegmentTag
          v-for="segment in caveSegments"
          :key="segment.id"
          :type="segment.type"
          :code="segment.code"
          :closed="segment.closed"
          size="small"
        />
      </div>
    </div>

    <div class="merge-row">
      <div class="canvas-wrap" @mousemove="onMouseMove" @mouseup="onMouseUp" @mouseleave="onMouseUp">
      <GridCanvas
        :width="CANVAS_W"
        :height="CANVAS_H"
        :grid-size="20"
        :meters-per-grid="1"
        title="图幅拼合台（仅已签认版本；拖动对齐 / 锚点吸附）"
      >
        <g
          v-for="(sheet, index) in signedSheets"
          :key="sheet.sketch.id"
          class="sheet-group"
          @mousedown.prevent="onMouseDown(sheet, $event)"
        >
          <rect
            :x="offsets[sheet.sketch.id] ?? 0"
            :y="40 + (index % 2) * 10"
            :width="widthOf(sheet.version)"
            height="96"
            rx="6"
            :fill="snapped[sheet.sketch.id] ? 'rgba(47,111,143,0.22)' : 'rgba(143,211,199,0.28)'"
            :stroke="snapped[sheet.sketch.id] ? '#2f6f8f' : '#1f8a70'"
            stroke-width="1.6"
          />
          <text :x="(offsets[sheet.sketch.id] ?? 0) + 8" :y="62 + (index % 2) * 10" font-size="12" fill="#1f3a4d">
            {{ sheet.version.code }} · V{{ sheet.version.version }}
          </text>
          <text :x="(offsets[sheet.sketch.id] ?? 0) + 8" :y="80 + (index % 2) * 10" font-size="11" fill="#4a5b6b">
            锚点 {{ sheet.version.anchorStake }}
          </text>
          <text :x="(offsets[sheet.sketch.id] ?? 0) + 8" :y="96 + (index % 2) * 10" font-size="11" fill="#7a8896">
            1:{{ sheet.version.scale }} · {{ sheet.version.gridCount }} 格 · {{ sheet.version.author }}
          </text>
          <line
            :x1="offsets[sheet.sketch.id] ?? 0"
            :y1="136 + (index % 2) * 10"
            :x2="(offsets[sheet.sketch.id] ?? 0) + 14"
            :y2="136 + (index % 2) * 10"
            stroke="#c98a1b"
            stroke-width="2"
          />
        </g>
        <text
          v-if="signedSheets.length === 0"
          :x="CANVAS_W / 2 - 130"
          :y="CANVAS_H / 2"
          font-size="13"
          fill="#8a97a3"
        >
          该洞穴暂无可拼合的已签认图幅，请先到「草图工作台」签认草图
        </text>
        <template #legend>
          <span>拖动已签认图幅可移动</span>
          <span>绿框 = 未吸附</span>
          <span>蓝框 = 已吸附对齐</span>
          <span>橙色短划 = 锚点桩号位置</span>
        </template>
      </GridCanvas>
      </div>

      <div class="side">
        <ClosureBadge
          :closure="closureResult.closure"
          :threshold="closureResult.threshold"
          :level="closureResult.level"
          :detail="closureResult.detail"
          :count="caveStations.length"
        />
        <el-card shadow="never" class="log-card">
          <template #header>吸附记录</template>
          <ul class="log">
            <li v-for="(line, index) in snapLog" :key="index">{{ line }}</li>
            <li v-if="snapLog.length === 0" class="muted">拖动图幅或点击「按桩号锚点吸附对齐」后显示结果</li>
          </ul>
        </el-card>
      </div>
    </div>

    <h3 class="section-title">图幅拼合顺序表（已签认版本）</h3>
    <el-table :data="mergeRows" border stripe>
      <el-table-column prop="order" label="拼合顺序" width="90" />
      <el-table-column prop="code" label="草图编号" width="110" />
      <el-table-column label="版本" width="80">
        <template #default="{ row }: { row: MergeRow }">
          <el-tag type="success" size="small" effect="plain">V{{ row.version }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="segment" label="洞段" width="100" />
      <el-table-column prop="author" label="绘制人" width="100" />
      <el-table-column prop="anchorStake" label="桩号对齐锚点" width="140" />
      <el-table-column label="对齐偏移" width="110">
        <template #default="{ row }: { row: MergeRow }">{{ row.offset }} px</template>
      </el-table-column>
      <el-table-column label="吸附状态" width="110">
        <template #default="{ row }: { row: MergeRow }">
          <el-tag :type="row.snapped ? 'success' : 'info'" size="small" effect="plain">
            {{ row.snapped ? '已吸附' : '未吸附' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="调整顺序" width="170">
        <template #default="{ $index }: { $index: number }">
          <el-button link type="primary" size="small" :disabled="$index === 0" @click="move($index, -1)">上移</el-button>
          <el-button
            link
            type="primary"
            size="small"
            :disabled="$index === mergeRows.length - 1"
            @click="move($index, 1)"
          >
            下移
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.pending-alert {
  margin-bottom: 12px;
}
.pending-list {
  margin: 4px 0 6px;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.9;
}
.pending-hint {
  font-size: 12px;
  color: #7a5a4a;
}
.seg-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.canvas-wrap {
  display: inline-flex;
}
.merge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 320px;
}
.log-card {
  border-radius: 12px;
}
.log {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #4a5b6b;
  line-height: 1.8;
}
.muted {
  color: #97a3af;
}
.sheet-group {
  cursor: grab;
}
</style>
