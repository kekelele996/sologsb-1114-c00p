<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Sketch, SketchStatus, SketchVersion, Station } from '@/types'
import { hasPendingDraft, latestVersion, sketchStatus } from '@/types'
import BearingInput from '@/components/common/BearingInput.vue'
import GridCanvas from '@/components/common/GridCanvas.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { formatDateTime } from '@/utils/datetime'
import { toRadians } from '@/utils/survey'
import { uid } from '@/utils/id'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)

const CANVAS_W = 760
const CANVAS_H = 440
const PAD = 46

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const selectedSegmentId = ref<string>('')
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

const STATUS_META: Record<SketchStatus, { label: string; type: 'warning' | 'primary' | 'success' }> = {
  draft: { label: '草稿（未签认）', type: 'warning' },
  revising: { label: '修图中（待签认）', type: 'primary' },
  signed: { label: '已签认', type: 'success' }
}

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

/** 该洞段待签认草稿数（有这些草稿时拼合页的桩号吸附会被拦下） */
const segmentSketches = computed(() =>
  sketchState.sketches
    .filter((sketch) => sketch.segmentId === selectedSegmentId.value)
    .sort((a, b) => a.draft.mergeOrder - b.draft.mergeOrder)
)

const pendingCount = computed(() => segmentSketches.value.filter((sketch) => hasPendingDraft(sketch)).length)

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

/** 当前正在编辑的草图（含状态判定） */
const editingSketch = computed<Sketch | null>(() =>
  editingId.value ? sketchState.sketches.find((item) => item.id === editingId.value) ?? null : null
)
const editingStatus = computed<SketchStatus | null>(() =>
  editingSketch.value ? sketchStatus(editingSketch.value) : null
)
const editingLatest = computed<SketchVersion | null>(() =>
  editingSketch.value ? latestVersion(editingSketch.value) : null
)

function validateForm(): boolean {
  if (!selectedSegmentId.value) {
    ElMessage.warning('请先选择洞段')
    return false
  }
  if (!form.code.trim()) {
    ElMessage.warning('请填写草图编号')
    return false
  }
  if (!form.author.trim()) {
    ElMessage.warning('请填写绘制人后再保存或签认')
    return false
  }
  return true
}

/** 保存草稿：新图进入「草稿」，已签认图进入「修图中」，都不产生新版本 */
async function submit(): Promise<void> {
  if (!validateForm()) return
  const existing = editingSketch.value
  const id = existing?.id ?? uid('sk')
  await sketchStore.getState().save(id, selectedSegmentId.value, {
    code: form.code.trim(),
    gridCount: Number(form.gridCount) || 0,
    scale: Number(form.scale) || 100,
    author: form.author.trim(),
    mergeOrder: Number(form.mergeOrder) || 1,
    anchorStake: form.anchorStake.trim(),
    imageNote: form.imageNote.trim()
  })
  ElMessage.success(existing ? '草稿已保存，签认前不参与图幅拼合' : '草稿已建立，签认后才会进入图幅拼合')
  editingId.value = id
}

/** 签认：先落一次草稿，再把当前内容冻结成下一个版本 */
async function signCurrent(): Promise<void> {
  if (!validateForm()) return
  const existing = editingSketch.value
  const id = existing?.id ?? uid('sk')
  const store = sketchStore.getState()
  const saved = await store.save(id, selectedSegmentId.value, {
    code: form.code.trim(),
    gridCount: Number(form.gridCount) || 0,
    scale: Number(form.scale) || 100,
    author: form.author.trim(),
    mergeOrder: Number(form.mergeOrder) || 1,
    anchorStake: form.anchorStake.trim(),
    imageNote: form.imageNote.trim()
  })
  const nextVersionNo = saved.versions.length + 1
  try {
    await ElMessageBox.confirm(
      `签认后当前内容将冻结为 V${nextVersionNo}，之后修图从新草稿开始，旧版本仅可查看。确认签认草图「${form.code.trim()}」？`,
      '签认确认',
      { type: 'warning', confirmButtonText: '确认签认', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await store.sign(id)
  ElMessage.success(`已签认，版本号 V${nextVersionNo}，绘制人 ${form.author.trim()}`)
  editingId.value = id
}

/** 从清单直接签认已保存的草稿 */
async function signSketch(sketch: Sketch): Promise<void> {
  if (!hasPendingDraft(sketch)) {
    ElMessage.info('该草图已是最新签认状态，无需重复签认')
    return
  }
  const nextVersionNo = sketch.versions.length + 1
  try {
    await ElMessageBox.confirm(
      `签认后当前草稿内容将冻结为 V${nextVersionNo}。确认签认草图「${sketch.draft.code}」？`,
      '签认确认',
      { type: 'warning', confirmButtonText: '确认签认', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await sketchStore.getState().sign(sketch.id)
  ElMessage.success(`草图「${sketch.draft.code}」已签认 V${nextVersionNo}`)
  if (editingId.value === sketch.id) {
    editSketch(sketchStore.getState().sketches.find((item) => item.id === sketch.id) ?? sketch)
  }
}

/** 放弃修图：草稿还原为最新签认版本，解除待签认状态 */
async function revertSketch(sketch: Sketch): Promise<void> {
  const latest = latestVersion(sketch)
  if (!latest) {
    ElMessage.warning('该草图尚未签认过，无法回到上一版本')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将放弃草稿中的未签认改动，内容还原为 V${latest.version}。确认放弃修图？`,
      '放弃修图',
      { type: 'warning', confirmButtonText: '放弃改动', cancelButtonText: '继续修图' }
    )
  } catch {
    return
  }
  await sketchStore.getState().revert(sketch.id)
  ElMessage.success(`已还原到 V${latest.version} 的签认内容`)
  if (editingId.value === sketch.id) {
    const refreshed = sketchStore.getState().sketches.find((item) => item.id === sketch.id)
    if (refreshed) editSketch(refreshed)
  }
}

function editSketch(sketch: Sketch): void {
  editingId.value = sketch.id
  form.code = sketch.draft.code
  form.gridCount = sketch.draft.gridCount
  form.scale = sketch.draft.scale
  form.author = sketch.draft.author
  form.mergeOrder = sketch.draft.mergeOrder
  form.anchorStake = sketch.draft.anchorStake
  form.imageNote = sketch.draft.imageNote
}

async function removeSketch(sketch: Sketch): Promise<void> {
  const latest = latestVersion(sketch)
  const suffix = latest ? `（含 ${latest.version} 个已签认版本，删除后不可恢复）` : ''
  await ElMessageBox.confirm(`确认删除草图「${sketch.draft.code}」？${suffix}`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除'
  })
  await sketchStore.getState().remove(sketch.id)
  ElMessage.success('草图记录已删除')
  if (editingId.value === sketch.id) resetForm()
}

/* ---------- 版本历史 ---------- */
const historySketch = ref<Sketch | null>(null)
const historyVisible = ref(false)
const historySelectedVersion = ref(1)

function openHistory(sketch: Sketch): void {
  historySketch.value = sketch
  historySelectedVersion.value = latestVersion(sketch)?.version ?? 1
  historyVisible.value = true
}

const historyVersion = computed<SketchVersion | null>(
  () => historySketch.value?.versions.find((version) => version.version === historySelectedVersion.value) ?? null
)
const historyStatus = computed<SketchStatus | null>(() =>
  historySketch.value ? sketchStatus(historySketch.value) : null
)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">草图工作台</h2>
        <p class="page-sub">
          保存的草图为可修改草稿，不参与图幅拼合；签认后当前内容冻结为新版本（版本号 / 绘制人 / 时间），修图从新草稿开始，旧版本可查看。
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
      <el-tag type="warning" effect="plain" v-if="pendingCount > 0">待签认草稿 {{ pendingCount }} 张 · 桩号吸附将被拦下</el-tag>
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
        <template #header>
          <div class="form-head">
            <span>{{ editingId ? '编辑草稿' : '新建草稿' }}</span>
            <el-tag v-if="editingStatus" :type="STATUS_META[editingStatus].type" size="small" effect="dark">
              {{ STATUS_META[editingStatus].label }}
            </el-tag>
          </div>
        </template>

        <el-alert
          v-if="editingStatus === 'revising'"
          type="info"
          :closable="false"
          show-icon
          class="form-banner"
          :title="`最新签认 V${editingLatest?.version}（${formatDateTime(editingLatest?.signedAt ?? '')}），当前草稿有未签认改动；保存后再签认即冻结为 V${(editingLatest?.version ?? 0) + 1}`"
        />
        <el-alert
          v-else-if="editingStatus === 'signed'"
          type="success"
          :closable="false"
          show-icon
          class="form-banner"
          :title="`当前内容即 V${editingLatest?.version} 签认版（${formatDateTime(editingLatest?.signedAt ?? '')}）；直接修改并保存即开始新草稿`"
        />

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
          <el-form-item label="绘制人" required>
            <el-input v-model="form.author" />
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
            <el-button type="primary" size="small" @click="submit">保存草稿</el-button>
            <el-button type="success" size="small" @click="signCurrent">保存并签认</el-button>
            <el-button v-if="editingId" size="small" @click="resetForm">取消编辑</el-button>
          </div>
        </el-form>
      </el-card>
    </div>

    <h3 class="section-title">该洞段草图清单</h3>
    <el-table :data="segmentSketches" border stripe row-key="id">
      <el-table-column label="状态" width="130">
        <template #default="{ row }: { row: Sketch }">
          <el-tag :type="STATUS_META[sketchStatus(row)].type" size="small" effect="plain">
            {{ STATUS_META[sketchStatus(row)].label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="draft.mergeOrder" label="拼合顺序" width="90" />
      <el-table-column prop="draft.code" label="草图编号" width="100" />
      <el-table-column label="版本" width="90">
        <template #default="{ row }: { row: Sketch }">
          <el-tag v-if="latestVersion(row)" size="small" type="success" effect="plain">
            V{{ latestVersion(row)?.version }}
          </el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="draft.gridCount" label="格数" width="70" />
      <el-table-column label="比例" width="90">
        <template #default="{ row }: { row: Sketch }">1 : {{ row.draft.scale }}</template>
      </el-table-column>
      <el-table-column prop="draft.author" label="绘制人" width="90" />
      <el-table-column prop="draft.anchorStake" label="锚点桩号" width="110" />
      <el-table-column label="最近签认" width="150">
        <template #default="{ row }: { row: Sketch }">
          <span v-if="latestVersion(row)">{{ formatDateTime(latestVersion(row)?.signedAt ?? '') }}</span>
          <span v-else class="muted">未签认</span>
        </template>
      </el-table-column>
      <el-table-column prop="draft.imageNote" label="图片数据说明" min-width="160" show-overflow-tooltip />
      <el-table-column label="操作" width="248" fixed="right">
        <template #default="{ row }: { row: Sketch }">
          <el-button link type="primary" size="small" @click="editSketch(row)">改草稿</el-button>
          <el-button
            link
            type="success"
            size="small"
            :disabled="!hasPendingDraft(row)"
            @click="signSketch(row)"
          >
            签认
          </el-button>
          <el-button
            link
            type="warning"
            size="small"
            :disabled="sketchStatus(row) !== 'revising'"
            @click="revertSketch(row)"
          >
            放弃修图
          </el-button>
          <el-button link type="info" size="small" :disabled="row.versions.length === 0" @click="openHistory(row)">
            版本
          </el-button>
          <el-button link type="danger" size="small" @click="removeSketch(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 版本历史：左侧版本列表，右侧只读快照内容 -->
    <el-dialog v-model="historyVisible" width="680px" :title="`版本历史 · ${historySketch?.draft.code ?? ''}`">
      <div v-if="historySketch" class="history">
        <ul class="history-list">
          <li
            v-for="version in [...historySketch.versions].reverse()"
            :key="version.version"
            :class="{ active: version.version === historySelectedVersion }"
            @click="historySelectedVersion = version.version"
          >
            <div class="hv-no">V{{ version.version }}</div>
            <div class="hv-meta">
              <span>{{ version.author || '绘制人未记录' }}</span>
              <span>{{ formatDateTime(version.signedAt, '历史导入，时间未记录') }}</span>
            </div>
            <el-tag v-if="version.version === latestVersion(historySketch)?.version" size="small" type="success">
              最新
            </el-tag>
          </li>
        </ul>
        <div class="history-detail" v-if="historyVersion">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="版本号">V{{ historyVersion.version }}</el-descriptions-item>
            <el-descriptions-item label="签认时间">
              {{ formatDateTime(historyVersion.signedAt, '历史导入，时间未记录') }}
            </el-descriptions-item>
            <el-descriptions-item label="绘制人">{{ historyVersion.author || '—' }}</el-descriptions-item>
            <el-descriptions-item label="草图编号">{{ historyVersion.code }}</el-descriptions-item>
            <el-descriptions-item label="格数 / 比例">
              {{ historyVersion.gridCount }} 格 · 1:{{ historyVersion.scale }}
            </el-descriptions-item>
            <el-descriptions-item label="拼合顺序">{{ historyVersion.mergeOrder }}</el-descriptions-item>
            <el-descriptions-item label="锚点桩号" :span="2">{{ historyVersion.anchorStake }}</el-descriptions-item>
            <el-descriptions-item label="图片说明" :span="2">{{ historyVersion.imageNote || '—' }}</el-descriptions-item>
          </el-descriptions>
          <el-alert
            v-if="historyStatus === 'revising'"
            type="warning"
            :closable="false"
            show-icon
            class="history-note"
            title="该草图另有一份未签认草稿正在修改，桩号吸附会被拦下，签认后本版本才会被新版本替换。"
          />
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
.form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.form-banner {
  margin-bottom: 10px;
}
.form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-left: 0;
}
.muted {
  color: #97a3af;
}
.history {
  display: flex;
  gap: 16px;
}
.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  width: 220px;
  flex-shrink: 0;
  border: 1px solid #e4e9ee;
  border-radius: 8px;
  overflow: hidden;
}
.history-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  cursor: pointer;
  border-bottom: 1px solid #eef1f4;
}
.history-list li:last-child {
  border-bottom: none;
}
.history-list li.active {
  background: #ecf5f1;
}
.hv-no {
  font-weight: 600;
  color: #1f8a70;
  width: 34px;
  flex-shrink: 0;
}
.hv-meta {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: #5a6a78;
  flex: 1;
}
.history-detail {
  flex: 1;
  min-width: 0;
}
.history-note {
  margin-top: 10px;
}
</style>
