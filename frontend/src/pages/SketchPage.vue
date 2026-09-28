<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Sketch, SketchStatus, SketchVersion, Station } from '@/types'
import { activeContent, latestVersion, sketchStatus } from '@/types'
import BearingInput from '@/components/common/BearingInput.vue'
import GridCanvas from '@/components/common/GridCanvas.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { toRadians } from '@/utils/survey'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)

const CANVAS_W = 760
const CANVAS_H = 440
const PAD = 46

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const selectedSegmentId = ref<string>('')
/** 正在编辑草稿的草图 id；null 表示新建 */
const editingId = ref<string | null>(null)
/** 草图朝向基准方位角：把洞段整体旋转到图纸正上方为前进方向 */
const baseBearing = ref(0)

const form = reactive({
  code: '',
  gridCount: 40,
  scale: 200,
  author: '',
  mergeOrder: 1,
  anchorStake: 'K0+000',
  imageNote: ''
})

/** 历史版本弹窗 */
const historyVisible = ref(false)
const historySketch = ref<Sketch | null>(null)
const historyVersions = computed<SketchVersion[]>(() =>
  historySketch.value ? [...historySketch.value.versions].sort((a, b) => b.version - a.version) : []
)

const segmentOptions = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)
const currentSegment = computed(() => segmentState.segments.find((segment) => segment.id === selectedSegmentId.value))

// IndexedDB 异步水合完成后自动选中第一条洞穴 / 洞段
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
  () => [selectedCaveId.value, segmentOptions.value.length] as const,
  () => {
    const list = segmentOptions.value
    if (!list.some((segment) => segment.id === selectedSegmentId.value)) {
      selectedSegmentId.value = list.length > 0 ? list[0].id : ''
    }
  },
  { immediate: true }
)

const segmentStations = computed<Station[]>(() =>
  stationState.stations
    .filter((station) => station.segmentId === selectedSegmentId.value)
    .sort((a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0]))
)

/** 测点折线：以起点为原点，按方位角/水平距投影到平面坐标 */
interface PlotPoint {
  station: Station
  x: number
  y: number
}

const rawPoints = computed<{ x: number; y: number; station: Station }[]>(() => {
  const points: { x: number; y: number; station: Station }[] = []
  let east = 0
  let north = 0
  for (const station of segmentStations.value) {
    const bearing = toRadians(station.bearing - baseBearing.value)
    east += station.horizontalDistance * Math.sin(bearing)
    north += station.horizontalDistance * Math.cos(bearing)
    points.push({ x: east, y: north, station })
  }
  return points
})

const plotScale = computed(() => {
  const xs = rawPoints.value.map((p) => Math.abs(p.x))
  const ys = rawPoints.value.map((p) => Math.abs(p.y))
  const maxExtent = Math.max(1, ...xs, ...ys)
  return Math.min((CANVAS_W - PAD * 2) / maxExtent, (CANVAS_H - PAD * 2) / maxExtent)
})

const plotPoints = computed<PlotPoint[]>(() =>
  rawPoints.value.map((point) => ({
    station: point.station,
    x: PAD + point.x * plotScale.value,
    y: CANVAS_H - PAD - point.y * plotScale.value
  }))
)

const polyline = computed(() => plotPoints.value.map((point) => `${point.x},${point.y}`).join(' '))

function dipArrow(point: PlotPoint, index: number): { x2: number; y2: number } {
  const length = 18 + Math.abs(point.station.dip)
  const rad = toRadians(point.station.bearing)
  const dir = point.station.dip >= 0 ? -1 : 1
  return {
    x2: point.x + Math.cos(rad) * length,
    y2: point.y + Math.sin(rad) * length * dir + (index % 2 === 0 ? 0 : 6)
  }
}

function resetForm(): void {
  editingId.value = null
  form.code = `S-${String(sketchState.sketches.length + 1).padStart(2, '0')}`
  form.gridCount = 40
  form.scale = 200
  form.author = caveState.caves.find((cave) => cave.id === selectedCaveId.value)?.surveyor ?? ''
  form.mergeOrder = sketchState.sketches.length + 1
  form.anchorStake = currentSegment.value?.startStake ?? 'K0+000'
  form.imageNote = ''
}

watch(() => selectedSegmentId.value, resetForm, { immediate: true })

const segmentSketches = computed(() =>
  sketchState.sketches
    .filter((sketch) => sketch.segmentId === selectedSegmentId.value)
    .sort((a, b) => a.mergeOrder - b.mergeOrder)
)

/** 该洞段待签认草稿数量（含仅有草稿、以及签认后修订中的） */
const pendingDraftCount = computed(() => segmentSketches.value.filter((sketch) => sketch.draft).length)

function readFormContent() {
  return {
    gridCount: Number(form.gridCount) || 0,
    scale: Number(form.scale) || 100,
    author: form.author.trim(),
    anchorStake: form.anchorStake.trim(),
    imageNote: form.imageNote.trim()
  }
}

function validateBeforeSave(signing: boolean): boolean {
  if (!selectedSegmentId.value) {
    ElMessage.warning('请先选择洞段')
    return false
  }
  if (!form.code.trim()) {
    ElMessage.warning('请填写草图编号')
    return false
  }
  if (signing && !form.author.trim()) {
    ElMessage.warning('签认需填写绘制人，以便随版本记录')
    return false
  }
  return true
}

/** 保存草稿：新建时落为「仅草稿」，已有草稿时覆盖更新；草稿不参与拼合 */
async function saveDraft(signing = false): Promise<void> {
  if (!validateBeforeSave(signing)) return
  const id = await sketchStore.getState().saveDraft({
    id: editingId.value ?? undefined,
    segmentId: selectedSegmentId.value,
    code: form.code.trim(),
    mergeOrder: Number(form.mergeOrder) || 1,
    content: readFormContent()
  })
  if (signing) {
    await sketchStore.getState().signOff(id)
    const signed = sketchState.sketches.find((item) => item.id === id)
    ElMessage.success(`草图「${form.code.trim()}」已签认冻结为 v${signed?.versions.length ?? 1}`)
  } else {
    ElMessage.success(editingId.value ? '草稿已更新，尚未签认，不参与拼合' : '草稿已保存，签认后才会进入图幅拼合')
  }
  resetForm()
}

/** 继续编辑已有草稿（仅草稿 / 修订中） */
function editDraft(sketch: Sketch): void {
  const content = sketch.draft
  if (!content) return
  editingId.value = sketch.id
  form.code = sketch.code
  form.gridCount = content.gridCount
  form.scale = content.scale
  form.author = content.author
  form.mergeOrder = sketch.mergeOrder
  form.anchorStake = content.anchorStake
  form.imageNote = content.imageNote
}

/** 从最新签认版本开出一份新草稿，之后的修改在草稿上进行，旧版本保持冻结 */
async function beginRevision(sketch: Sketch): Promise<void> {
  const base = latestVersion(sketch)
  if (!base) return
  editingId.value = sketch.id
  form.code = sketch.code
  form.gridCount = base.gridCount
  form.scale = base.scale
  form.author = base.author
  form.mergeOrder = sketch.mergeOrder
  form.anchorStake = base.anchorStake
  form.imageNote = base.imageNote
  await sketchStore.getState().saveDraft({
    id: sketch.id,
    segmentId: sketch.segmentId,
    code: sketch.code,
    mergeOrder: sketch.mergeOrder,
    content: {
      gridCount: base.gridCount,
      scale: base.scale,
      author: base.author,
      anchorStake: base.anchorStake,
      imageNote: base.imageNote
    }
  })
  ElMessage.info(`已基于 v${base.version} 开出新草稿，保存签认后生成 v${base.version + 1}`)
}

/** 签认列表中已有草稿的草图 */
async function signSketch(sketch: Sketch): Promise<void> {
  if (!sketch.draft) return
  if (!sketch.draft.author.trim()) {
    ElMessage.warning('该草稿未填写绘制人，请先编辑补全再签认')
    return
  }
  await ElMessageBox.confirm(
    `确认签认草图「${sketch.code}」？签认后当前内容将冻结为 v${sketch.versions.length + 1}，不可再改。`,
    '签认确认',
    { type: 'warning', confirmButtonText: '签认', cancelButtonText: '取消' }
  )
  await sketchStore.getState().signOff(sketch.id)
  ElMessage.success(`草图「${sketch.code}」已签认，可参与图幅拼合`)
}

/** 取消修订：丢弃草稿，仅草稿草图会整体删除 */
async function discardDraft(sketch: Sketch): Promise<void> {
  const draftOnly = sketch.versions.length === 0
  await ElMessageBox.confirm(
    draftOnly
      ? `草图「${sketch.code}」尚未签认过，丢弃草稿将删除整张草图，确认？`
      : `确认丢弃草图「${sketch.code}」的未签认草稿？内容将回到 v${sketch.versions.length}。`,
    '丢弃草稿确认',
    { type: 'warning', confirmButtonText: '丢弃', cancelButtonText: '取消' }
  )
  await sketchStore.getState().discardDraft(sketch.id)
  if (editingId.value === sketch.id) resetForm()
  ElMessage.success(draftOnly ? '未签认草图已删除' : '草稿已丢弃，内容回到最新签认版本')
}

async function removeSketch(sketch: Sketch): Promise<void> {
  await ElMessageBox.confirm(
    `确认删除草图「${sketch.code}」？其 ${sketch.versions.length} 个签认版本与草稿都将一并删除。`,
    '删除确认',
    { type: 'warning' }
  )
  await sketchStore.getState().remove(sketch.id)
  if (editingId.value === sketch.id) resetForm()
  ElMessage.success('草图记录已删除')
}

function openHistory(sketch: Sketch): void {
  historySketch.value = sketch
  historyVisible.value = true
}

const STATUS_META: Record<SketchStatus, { type: 'info' | 'success' | 'warning' }> = {
  'draft-only': { type: 'warning' },
  signed: { type: 'success' },
  revising: { type: 'info' }
}

function statusOf(sketch: Sketch): SketchStatus {
  return sketchStatus(sketch)
}

function statusLabel(sketch: Sketch): string {
  switch (statusOf(sketch)) {
    case 'draft-only':
      return '草稿（未签认）'
    case 'signed':
      return `已签认 v${sketch.versions.length}`
    case 'revising':
      return `修订中（最新 v${sketch.versions.length}）`
  }
}

function statusType(sketch: Sketch): 'info' | 'success' | 'warning' {
  return STATUS_META[statusOf(sketch)].type
}

/** 列表展示的内容：草稿优先，否则最新签认版本 */
function contentOf(sketch: Sketch) {
  return activeContent(sketch)
}

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">草图工作台</h2>
        <p class="page-sub">
          在坐标纸网格上按测点折线绘制洞段平面草图，标注测点桩号与倾角箭头。每张草图分草稿与已签认：草稿可继续改但不参与拼合，签认后内容冻结为新版本。
        </p>
      </div>
      <el-tag type="info" effect="plain">当前比例 1 : {{ form.scale }}</el-tag>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 200px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-select v-model="selectedSegmentId" placeholder="选择洞段" style="width: 220px">
        <el-option v-for="segment in segmentOptions" :key="segment.id" :label="segment.code" :value="segment.id" />
      </el-select>
      <el-tag effect="plain">测点 {{ segmentStations.length }} 个</el-tag>
      <el-tag effect="plain">草图 {{ segmentSketches.length }} 张</el-tag>
      <el-tag :type="pendingDraftCount > 0 ? 'warning' : 'success'" effect="plain">
        待签认草稿 {{ pendingDraftCount }} 张
      </el-tag>
      <div class="base-bearing">
        <BearingInput v-model="baseBearing" kind="bearing" label="草图基准方位" @invalid="(msg: string) => ElMessage.warning(msg)" />
      </div>
    </div>

    <div class="canvas-row">
      <GridCanvas
        :width="CANVAS_W"
        :height="CANVAS_H"
        :grid-size="20"
        :meters-per-grid="1"
        title="洞段平面草图（坐标纸网格）"
      >
        <g v-if="plotPoints.length > 1">
          <polyline :points="polyline" fill="none" stroke="#2f6f8f" stroke-width="2.5" stroke-linejoin="round" />
        </g>
        <g v-for="(point, index) in plotPoints" :key="point.station.id">
          <circle :cx="point.x" :cy="point.y" r="4.5" fill="#1f3a4d" />
          <line
            :x1="point.x"
            :y1="point.y"
            :x2="dipArrow(point, index).x2"
            :y2="dipArrow(point, index).y2"
            stroke="#c98a1b"
            stroke-width="1.6"
            marker-end="url(#dipArrowHead)"
          />
          <text :x="point.x + 7" :y="point.y - 7" font-size="11" fill="#35506b">
            {{ point.station.code }} · {{ point.station.dip }}°
          </text>
        </g>
        <text :x="PAD - 30" :y="CANVAS_H - 12" font-size="11" fill="#8a97a3">
          起点 K0
        </text>
        <text v-if="plotPoints.length === 0" :x="CANVAS_W / 2 - 90" :y="CANVAS_H / 2" font-size="13" fill="#8a97a3">
          该洞段暂无测点，请先到「测点读数」录入
        </text>
        <defs>
          <marker id="dipArrowHead" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="#c98a1b" />
          </marker>
        </defs>
        <template #legend>
          <span>● 测点</span>
          <span>▸ 倾角方向</span>
          <span>深色线 = 5 格</span>
          <span>1 格 = 1 m</span>
        </template>
      </GridCanvas>

      <el-card shadow="never" class="sketch-form">
        <template #header>{{ editingId ? '编辑草稿（未签认）' : '新建草图（先存草稿）' }}</template>
        <el-form label-width="90px" size="small">
          <el-form-item label="草图编号" required>
            <el-input v-model="form.code" placeholder="如 S-03" />
          </el-form-item>
          <el-form-item label="坐标纸格数">
            <el-input-number v-model="form.gridCount" :min="1" :controls="false" style="width: 100%" />
          </el-form-item>
          <el-form-item label="缩放比例">
            <el-input-number v-model="form.scale" :min="10" :step="10" :controls="false" style="width: 100%" />
          </el-form-item>
          <el-form-item label="绘制人">
            <el-input v-model="form.author" placeholder="签认时随版本记录" />
          </el-form-item>
          <el-form-item label="拼合顺序">
            <el-input-number v-model="form.mergeOrder" :min="1" :controls="false" style="width: 100%" />
          </el-form-item>
          <el-form-item label="锚点桩号">
            <el-input v-model="form.anchorStake" placeholder="如 K0+120" />
          </el-form-item>
          <el-form-item label="图片说明">
            <el-input v-model="form.imageNote" type="textarea" :rows="2" placeholder="草图内容与左壁/右壁标注说明" />
          </el-form-item>
          <div class="form-actions">
            <el-button size="small" @click="saveDraft(false)">保存草稿</el-button>
            <el-button type="primary" size="small" @click="saveDraft(true)">保存并签认</el-button>
            <el-button v-if="editingId" size="small" @click="resetForm">取消</el-button>
          </div>
        </el-form>
      </el-card>
    </div>

    <h3 class="section-title">该洞段草图清单</h3>
    <el-table :data="segmentSketches" border stripe>
      <el-table-column prop="mergeOrder" label="拼合顺序" width="90" />
      <el-table-column prop="code" label="草图编号" width="100" />
      <el-table-column label="签认状态" width="170">
        <template #default="{ row }: { row: Sketch }">
          <el-tag :type="statusType(row)" size="small" effect="plain">{{ statusLabel(row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="版本" width="70">
        <template #default="{ row }: { row: Sketch }">{{ row.versions.length }}</template>
      </el-table-column>
      <el-table-column label="格数" width="70">
        <template #default="{ row }: { row: Sketch }">{{ contentOf(row)?.gridCount ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="比例" width="90">
        <template #default="{ row }: { row: Sketch }">
          {{ contentOf(row) ? `1 : ${contentOf(row)?.scale}` : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="绘制人" width="90">
        <template #default="{ row }: { row: Sketch }">{{ contentOf(row)?.author || '—' }}</template>
      </el-table-column>
      <el-table-column label="锚点桩号" width="120">
        <template #default="{ row }: { row: Sketch }">{{ contentOf(row)?.anchorStake || '—' }}</template>
      </el-table-column>
      <el-table-column label="图片数据说明" min-width="180" show-overflow-tooltip>
        <template #default="{ row }: { row: Sketch }">{{ contentOf(row)?.imageNote || '' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }: { row: Sketch }">
          <el-button v-if="row.draft" link type="primary" size="small" @click="editDraft(row)">编辑草稿</el-button>
          <el-button v-if="!row.draft && row.versions.length > 0" link type="primary" size="small" @click="beginRevision(row)">
            修订
          </el-button>
          <el-button v-if="row.draft" link type="success" size="small" @click="signSketch(row)">签认</el-button>
          <el-button v-if="row.draft && row.versions.length > 0" link type="warning" size="small" @click="discardDraft(row)">
            取消修订
          </el-button>
          <el-button
            v-if="row.versions.length > 0"
            link
            type="info"
            size="small"
            @click="openHistory(row)"
          >
            历史版本
          </el-button>
          <el-button link type="danger" size="small" @click="removeSketch(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="historyVisible" :title="'历史版本 · ' + (historySketch?.code ?? '')" width="640px">
      <div v-if="historySketch" class="history-list">
        <div v-for="version in historyVersions" :key="version.version" class="history-item">
          <div class="history-head">
            <el-tag size="small" :type="version.version === historySketch.versions.length ? 'success' : 'info'">
              v{{ version.version }}
              {{ version.version === historySketch.versions.length ? '（最新）' : '' }}
            </el-tag>
            <span class="history-meta">绘制人：{{ version.author || '—' }}</span>
            <span class="history-meta">签认时间：{{ formatDateTime(version.signedAt) }}</span>
          </div>
          <div class="history-body">
            <span>坐标纸 {{ version.gridCount }} 格</span>
            <span>比例 1:{{ version.scale }}</span>
            <span>锚点 {{ version.anchorStake }}</span>
            <span>拼合顺序 {{ historySketch.mergeOrder }}</span>
          </div>
          <p v-if="version.imageNote" class="history-note">{{ version.imageNote }}</p>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.base-bearing {
  width: 240px;
}
.canvas-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
.sketch-form {
  width: 320px;
  border-radius: 12px;
}
.form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-left: 0;
}
.history-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 60vh;
  overflow-y: auto;
}
.history-item {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
}
.history-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.history-meta {
  font-size: 12px;
  color: #4a5b6b;
}
.history-body {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12px;
  color: #35506b;
}
.history-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: #5a6a7a;
}
</style>
