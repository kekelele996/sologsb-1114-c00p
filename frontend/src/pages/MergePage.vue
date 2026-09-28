<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Sketch } from '@/types'
import { latestVersion } from '@/types'
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

/** 当前洞穴下存在未签认草稿的草图（含仅草稿与签认后修订中） */
const pendingDrafts = computed<Sketch[]>(() =>
  sketchState.sketches
    .filter(
      (sketch) =>
        sketch.draft && caveSegments.value.some((segment) => segment.id === sketch.segmentId)
    )
    .sort((a, b) => a.mergeOrder - b.mergeOrder)
)

/**
 * 可拼合图幅：仅至少有一个签认版本的草图参与，内容取最新签认版本。
 * 仅草稿、修订中的草图不在此列（修订中草图仍显示其上一签认版本）。
 */
const mergeSketches = computed<Sketch[]>(() =>
  sketchState.sketches
    .filter(
      (sketch) =>
        sketch.versions.length > 0 &&
        caveSegments.value.some((segment) => segment.id === sketch.segmentId)
    )
    .sort((a, b) => a.mergeOrder - b.mergeOrder)
)

function segmentOf(sketch: Sketch): string {
  const segment = segmentState.segments.find((item) => item.id === sketch.segmentId)
  return segment ? segment.code : '未归属'
}

function widthOf(sketch: Sketch): number {
  const version = latestVersion(sketch)
  if (!version) return 88
  return Math.max(88, Math.round(version.gridCount * (200 / Math.max(10, version.scale)) * 4))
}

const totalWidth = computed(() =>
  mergeSketches.value.reduce((sum, sketch) => sum + widthOf(sketch) + 10, 0)
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
  mergeSketches,
  (list) => {
    list.forEach((sketch) => {
      if (offsets[sketch.id] === undefined) offsets[sketch.id] = 0
      if (snapped[sketch.id] === undefined) snapped[sketch.id] = false
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

/** 按桩号锚点自动吸附：以最小锚点桩号为原点，按桩号差换算横向偏移 */
function autoAlign(): void {
  const list = mergeSketches.value
  if (list.length === 0) {
    ElMessage.warning('当前洞穴暂无已签认可拼合草图')
    return
  }
  // 同一洞段存在未签认草稿时必须先签认，避免把现场修订漏进/误拼，吸附整体停下
  if (pendingDrafts.value.length > 0) {
    const detail = pendingDrafts.value
      .map((sketch) => `${sketch.code}（洞段 ${segmentOf(sketch)}，锚点 ${sketch.draft?.anchorStake ?? '—'}）`)
      .join('、')
    snapLog.value = [
      `按桩号吸附已中止：以下草图存在未签认草稿，请先到草图工作台签认：${detail}`,
      '其余已签认图幅仍正常显示，可拖动手动对齐。'
    ]
    ElMessageBox.alert(
      `以下草图尚有未签认草稿，按桩号吸附已中止：\n${detail}\n\n请先在「草图工作台」签认后再吸附；已签认图幅仍正常显示。`,
      '存在未签认草稿',
      { type: 'warning', confirmButtonText: '知道了' }
    )
    return
  }
  const base = Math.min(...list.map((sketch) => stakeToNumber(latestVersion(sketch)!.anchorStake)))
  const logs: string[] = []
  list.forEach((sketch) => {
    const version = latestVersion(sketch)!
    const stake = stakeToNumber(version.anchorStake)
    const target = Math.round((stake - base) * PX_PER_METER)
    offsets[sketch.id] = target
    snapped[sketch.id] = true
    logs.push(`${sketch.code} v${version.version} 锚点 ${version.anchorStake} → 偏移 ${target}px`)
  })
  snapLog.value = logs
  ElMessage.success(`已按桩号锚点吸附 ${list.length} 张图幅`)
}

function onMouseDown(sketch: Sketch, event: MouseEvent): void {
  draggingId.value = sketch.id
  dragStartX.value = event.clientX
  dragOriginOffset.value = offsets[sketch.id] ?? 0
}

function onMouseMove(event: MouseEvent): void {
  if (!draggingId.value) return
  const delta = event.clientX - dragStartX.value
  const raw = Math.max(-200, Math.min(CANVAS_W - 60, dragOriginOffset.value + delta))
  const list = mergeSketches.value
  const index = list.findIndex((sketch) => sketch.id === draggingId.value)
  let value = Math.round(raw)
  let snapTarget: string | null = null
  const others = list.filter((sketch) => sketch.id !== draggingId.value)
  for (const other of others) {
    const otherRight = (offsets[other.id] ?? 0) + widthOf(other)
    if (Math.abs(value - otherRight) <= SNAP_PX) {
      value = otherRight
      snapTarget = other.code
      break
    }
  }
  offsets[draggingId.value] = value
  snapped[draggingId.value] = snapTarget !== null
  if (snapTarget) {
    const current = list[index]
    snapLog.value = [`${current.code} 吸附到 ${snapTarget} 右边缘（偏移 ${value}px）`]
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
}

const mergeRows = computed<MergeRow[]>(() =>
  mergeSketches.value.map((sketch, index) => {
    const version = latestVersion(sketch)!
    return {
      order: index + 1,
      code: sketch.code,
      version: version.version,
      segment: segmentOf(sketch),
      author: version.author,
      anchorStake: version.anchorStake,
      offset: offsets[sketch.id] ?? 0,
      snapped: snapped[sketch.id] ?? false
    }
  })
)

async function move(index: number, direction: -1 | 1): Promise<void> {
  const list = [...mergeSketches.value]
  const target = index + direction
  if (target < 0 || target >= list.length) return
  const temp = list[index]
  list[index] = list[target]
  list[target] = temp
  await sketchStore.getState().reorder(list.map((sketch) => sketch.id))
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
          仅已签认图幅参与拼合（取最新签认版本）；拖动图幅可按相邻边缘吸附，按桩号锚点一键对齐前会检查未签认草稿。
        </p>
      </div>
      <div class="head-actions">
        <el-button type="primary" @click="autoAlign">按桩号锚点吸附对齐</el-button>
        <el-button @click="exportMergeTable">导出拼合顺序表</el-button>
      </div>
    </div>

    <el-alert
      v-if="pendingDrafts.length > 0"
      class="draft-alert"
      type="warning"
      show-icon
      :closable="false"
      title="存在未签认草稿，按桩号吸附将中止"
    >
      <template #default>
        待签认：
        <el-tag
          v-for="sketch in pendingDrafts"
          :key="sketch.id"
          type="warning"
          size="small"
          effect="plain"
          class="draft-tag"
        >
          {{ sketch.code }}（洞段 {{ segmentOf(sketch) }}）
        </el-tag>
        <span class="draft-hint">草稿不参与拼合；签认后才会进入/更新图幅。</span>
      </template>
    </el-alert>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 220px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-tag effect="plain">已签认图幅 {{ mergeSketches.length }} 张</el-tag>
      <el-tag :type="pendingDrafts.length > 0 ? 'warning' : 'success'" effect="plain">
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
        title="图幅拼合台（拖动对齐 / 锚点吸附）"
      >
        <g
          v-for="(sketch, index) in mergeSketches"
          :key="sketch.id"
          class="sheet-group"
          @mousedown.prevent="onMouseDown(sketch, $event)"
        >
          <rect
            :x="offsets[sketch.id] ?? 0"
            :y="40 + (index % 2) * 10"
            :width="widthOf(sketch)"
            height="96"
            rx="6"
            :fill="snapped[sketch.id] ? 'rgba(47,111,143,0.22)' : 'rgba(143,211,199,0.28)'"
            :stroke="snapped[sketch.id] ? '#2f6f8f' : '#1f8a70'"
            stroke-width="1.6"
          />
          <text :x="(offsets[sketch.id] ?? 0) + 8" :y="62 + (index % 2) * 10" font-size="12" fill="#1f3a4d">
            {{ sketch.code }} · v{{ latestVersion(sketch)?.version }}
          </text>
          <text :x="(offsets[sketch.id] ?? 0) + 8" :y="80 + (index % 2) * 10" font-size="11" fill="#4a5b6b">
            锚点 {{ latestVersion(sketch)?.anchorStake }}
          </text>
          <text :x="(offsets[sketch.id] ?? 0) + 8" :y="96 + (index % 2) * 10" font-size="11" fill="#7a8896">
            1:{{ latestVersion(sketch)?.scale }} · {{ latestVersion(sketch)?.gridCount }} 格
          </text>
          <line
            :x1="offsets[sketch.id] ?? 0"
            :y1="136 + (index % 2) * 10"
            :x2="(offsets[sketch.id] ?? 0) + 14"
            :y2="136 + (index % 2) * 10"
            stroke="#c98a1b"
            stroke-width="2"
          />
        </g>
        <text
          v-if="mergeSketches.length === 0"
          :x="CANVAS_W / 2 - 130"
          :y="CANVAS_H / 2"
          font-size="13"
          fill="#8a97a3"
        >
          该洞穴暂无已签认图幅，请先到「草图工作台」建立并签认
        </text>
        <template #legend>
          <span>仅已签认图幅显示</span>
          <span>拖动图幅可移动</span>
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
      <el-table-column label="签认版本" width="90">
        <template #default="{ row }: { row: MergeRow }">
          <el-tag type="success" size="small" effect="plain">v{{ row.version }}</el-tag>
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
      <el-table-column label="调整顺序" width="160">
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
.draft-alert {
  margin-bottom: 12px;
}
.draft-tag {
  margin: 0 6px 0 0;
}
.draft-hint {
  margin-left: 4px;
  font-size: 12px;
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
.sheet-group {
  cursor: grab;
}
</style>
