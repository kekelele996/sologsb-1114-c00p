/* 临时验证脚本：Dexie v2 -> v3 迁移 + 草稿/签认/排序/持久化逻辑 */
import 'fake-indexeddb/auto'
import Dexie, { type Table } from 'dexie'
import { db } from '../src/hooks/usePersistentStore'
import { sketchStore } from '../src/stores/sketchStore'
import { hasPendingDraft, latestVersion, sketchStatus } from '../src/types/index'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++
    console.error('❌', msg)
  } else {
    console.log('✅', msg)
  }
}

// 1) 先按 v2 结构建库并写入一条旧式扁平草图
const oldDbName = 'gbcavesurvey'
const v2 = new Dexie(oldDbName) as Dexie & {
  sketches: Table<Record<string, unknown>, string>
}
v2.version(1).stores({ caves: 'id', segments: 'id', stations: 'id', sketches: 'id, segmentId, code', meta: 'key' })
v2.version(2).stores({
  caves: 'id, name, region, archived',
  segments: 'id, caveId, code, type',
  stations: 'id, segmentId, code, date',
  sketches: 'id, segmentId, code, mergeOrder',
  meta: 'key'
})
await v2.sketches.put({
  id: 'old_1',
  segmentId: 'seg_1',
  code: 'S-01',
  gridCount: 40,
  scale: 200,
  author: '老周',
  mergeOrder: 3,
  anchorStake: 'K0+200',
  imageNote: '旧版扁平记录'
})
v2.close()

// 2) 用当前 schema 打开，触发 v3 迁移
await db.open()
const migrated = await db.sketches.get('old_1')
assert(!!migrated, 'v2 草图迁移后仍存在')
assert(migrated!.versions.length === 1, '迁移出 1 个签认版本')
assert(migrated!.versions[0].version === 1, '迁移版本号为 V1')
assert(migrated!.versions[0].signedAt === '', '迁移数据签认时间留空（历史导入）')
assert(migrated!.versions[0].code === 'S-01', '版本快照保留编号')
assert(migrated!.versions[0].author === '老周', '版本快照保留绘制人')
assert(migrated!.draft.code === 'S-01', '草稿由旧内容生成')
assert(migrated!.draft.mergeOrder === 3, '草稿保留拼合顺序号')
assert(migrated!.draftDirty === false, '迁移后为干净已签认状态')
assert(sketchStatus(migrated!) === 'signed', '迁移草图业务状态 = 已签认')
assert(!('code' in migrated), '旧顶层扁平字段已清除: code')
assert(!('mergeOrder' in migrated), '旧顶层扁平字段已清除: mergeOrder')

// 3) store 水合
await sketchStore.getState().hydrate()
assert(sketchStore.getState().sketches.length === 1, 'store 水合 1 张草图')

// 4) 新草图先保存为草稿：未签认、不参与拼合判定
const content = {
  code: 'S-02',
  gridCount: 24,
  scale: 200,
  author: '小新',
  mergeOrder: 1,
  anchorStake: 'K0+000',
  imageNote: '新画的'
}
await sketchStore.getState().save('new_1', 'seg_1', content)
let fresh = sketchStore.getState().sketches.find((s) => s.id === 'new_1')!
assert(!!fresh, '新草稿已保存')
assert(sketchStatus(fresh) === 'draft', '新草图状态 = 草稿')
assert(hasPendingDraft(fresh) === true, '未签认草稿存在 → 桩号吸附应被拦')
assert(latestVersion(fresh) === null, '草稿无签认版本')
assert(!!fresh.draft.updatedAt, '草稿记录了保存时间')

// 5) 签认 → 冻结 V1
await sketchStore.getState().sign('new_1')
fresh = sketchStore.getState().sketches.find((s) => s.id === 'new_1')!
assert(fresh.versions.length === 1, '签认后有 1 个版本')
assert(fresh.versions[0].version === 1, '首个版本号 V1')
assert(fresh.versions[0].author === '小新', 'V1 记录绘制人')
assert(!!fresh.versions[0].signedAt, 'V1 记录签认时间')
assert(sketchStatus(fresh) === 'signed', '签认后状态 = 已签认')
assert(hasPendingDraft(fresh) === false, '已签认 → 不拦截吸附')

// 6) 修改并保存草稿：进入修图中，仍能看到 V1，拼合应使用 V1
await new Promise((r) => setTimeout(r, 5))
await sketchStore.getState().save('new_1', 'seg_1', { ...content, gridCount: 30, imageNote: '现场改了' })
fresh = sketchStore.getState().sketches.find((s) => s.id === 'new_1')!
assert(sketchStatus(fresh) === 'revising', '改图后状态 = 修图中')
assert(hasPendingDraft(fresh) === true, '修图中 → 拦截吸附')
assert(fresh.versions.length === 1, '改图不新增版本，仍只有 V1')
assert(fresh.versions[0].gridCount === 24, 'V1 快照冻结在旧格数 24')
assert(fresh.draft.gridCount === 30, '草稿格数已改为 30')

// 7) 再签认 → V2
await sketchStore.getState().sign('new_1')
fresh = sketchStore.getState().sketches.find((s) => s.id === 'new_1')!
assert(fresh.versions.length === 2, '二次签认产生 V2')
assert(fresh.versions[1].version === 2, '版本号递增 V2')
assert(fresh.versions[1].gridCount === 30, 'V2 冻结新内容（30 格）')
assert(fresh.versions[0].gridCount === 24, '旧版本 V1 仍可查看且未被改写')
assert(sketchStatus(fresh) === 'signed', 'V2 签认后状态 = 已签认')

// 8) 放弃修图：还原到最新版本
await sketchStore.getState().save('new_1', 'seg_1', { ...content, gridCount: 99, imageNote: '临时乱改' })
fresh = sketchStore.getState().sketches.find((s) => s.id === 'new_1')!
assert(sketchStatus(fresh) === 'revising', '再次改图 = 修图中')
await sketchStore.getState().revert('new_1')
fresh = sketchStore.getState().sketches.find((s) => s.id === 'new_1')!
assert(fresh.draft.gridCount === 30, '放弃修图后草稿还原为 V2 内容（30 格）')
assert(fresh.draft.imageNote === '现场改了', '放弃修图还原图片说明')
assert(sketchStatus(fresh) === 'signed', '放弃修图后回到已签认状态，解除拦截')

// 9) 拼合顺序互换
await sketchStore.getState().swapOrder('old_1', 'new_1')
const after = sketchStore.getState().sketches
const sorted = [...after].sort((a, b) => a.draft.mergeOrder - b.draft.mergeOrder).map((s) => s.id)
const oldOrder = after.find((s) => s.id === 'old_1')!.draft.mergeOrder
const newOrder = after.find((s) => s.id === 'new_1')!.draft.mergeOrder
assert(oldOrder === 1 && newOrder === 3, `顺序号已互换（old=${oldOrder}, new=${newOrder}）`)
assert(sorted[0] === 'old_1' && sorted[1] === 'new_1', '水合排序按草稿顺序号：old_1(1) 在前')

// 10) 重开（重新水合）验证持久化
const rehydrated = await db.sketches.toArray()
const rNew = rehydrated.find((s: Sketch) => s.id === 'new_1')!
assert(rNew.versions.length === 2, '刷新后版本历史保留（2 个版本）')
assert(rNew.versions[0].signedAt !== '' && rNew.versions[1].signedAt !== '', '刷新后签认时间保留')
assert(rNew.draft.mergeOrder === 3, '刷新后拼合顺序保留')
assert(sketchStatus(rNew) === 'signed', '刷新后签认状态保留')

console.log(failures === 0 ? '\n全部断言通过' : `\n${failures} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
