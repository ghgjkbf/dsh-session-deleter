# 计划评审 — dsh-session-deleter

对用户版 M0–M6 里程碑的评审结论。分三部分：可采纳的改进、已证实的问题、原计划的疏漏。
**每条都附本轮取到的决定性命中**，不做无证据的推测性评论。

---

## A. 改进点（接受，且已并入）

### A1. 「线 A / 线 B」二分是正确的架构骨架
用户引入的这条切分把「UI 可见性」与「模型面可见性」解耦，是本方案最有价值的一步。本轮取证**证实**它是唯一自洽的切分：`replace` surface op 对 transcript 天然不可见（§2.2），所以任何"只改写 surface、想让用户看不见"的设计都是死路；反之遮蔽 UI 只需 slot 层替换。骨架成立。

### A2. M0.5 作为硬前置（事件模式映射 + foldSurface 验证器 + 引用扰动器）
判断正确。日志重写的 `replace` op 校验规则非常严格（`sourceEventSeqs` 必须稠密无重复、`assistant/message` 禁带 `sourceEventSeqs`、node 0 只能被覆盖该节点的 `system/message` 改写）。**在扰动器全绿之前碰 M4/M6 等于盲写。**

### A3. M6（D2c 中段重写）默认不做
成本/收益判断正确。中段重写要重编号全部后继 seq，且引发引用扰动，是三个层级里唯一会伤及无关事件的操作。**建议在记忆文档里把它标为"需重新论证"而非"延后"，避免以后顺手做掉。**

### A4. M0 的探针式开局
用探针先关闭可行性，而不是先设计再发现不可行。**两个探针都产出了否定性答案**（见 B1/B2），这提前避免了 M3/M4 走错一整条路。这个方法是本轮最大收益来源，建议 M-1 的新增项也沿用探针式收口。

---

## B. 已证实的问题（探针结果）

### B1. 探针 a 的结果：**没有客户端 history 过滤钩子**
分页是整段切片而非逐条 drop（`history.js` L395-426）。原「线 A 可行性」的朴素设想（插一条过滤钩子让某条消息不出现在 history 里）**不成立**。
但**线 A 依然可行**，只是机制换成：注册同 key 的 `conversation.chat.node` renderer 接管行渲染。这条路是官方机制（`replaceRisk: shadows-shipped-ui`，且有独立示例证明 shipped 自己就用公开 API 注册 `key: "user"`）。

**新增的关键约束**（原计划没有）：slot 遮蔽**靠 `priority` 而非注册顺序**，同 key 同 priority 抛错。shipped 用默认 0 ⇒ **插件必须 `priority: -1`**。

### B2. 探针 b 的结果：**「用户消息操作栏插槽」不存在**
`MessageIconActions.extraActions` 的注释说"Slot-rendered actions owned by independent plugins"，但**只有 assistant 侧填充它**；`UserMessageNodeView` 构造时根本没传 `extraActions`。全库 `conversation.chat.*` 只有 4 个槽名，没有 user 专用的。
turn-rewind 之所以能在用户消息下放按钮，靠的是 `createPortal` + `MutationObserver(document.body)` 扫 DOM 硬注入 —— 那不是插槽机制。

⇒ **M4（D2b 尾部截断）的触发入口需要重新选型**，三选一（成本递增、侵入递减）：
1. 替换 `conversation.chat.node` 的 `user` key —— 官方、稳，但要重实现整行（Markdown/图片/引用芯片/copy/branch 全丢）。
2. portal 注入 —— 零侵入、保留原行，但绑 DOM 结构，上游改版即碎。
3. 入口上提到 `conversation.session.header.actions`（会话级）—— 最稳，交互变差。

**推荐 1 + 复用 shipped 的内联逻辑**：我们接管 `user` key，但把 shipped 的 `UserMessageNodeView` 行为在我们自己的组件里重建一次，并在其下追加删除按钮。代价是必须跟住上游行渲染改动。

### B3. Definition registry 与 slot registry 是两套互斥规则
- `uiConversation.events.register`：key = `definition.kind`，**重复直接抛错**，无 priority。⇒ 无法用新 Definition 抢走 shipped 的 match。
- `ctx.slots.register`：keyed 槽同 key + 同 priority 抛错，**不同 priority 可遮蔽，最低者渲染**。

⇒ **只有 slot 层能真正接管渲染。** 任何"注册个新 Definition 让它匹配并吞掉这个事件"的想法都不成立。这条是本轮最有价值的负面结论，建议写进代码注释防止后来者踩。

---

## C. 疏漏（原计划未覆盖，已补进 MEMORY.md）

### C1. 【严重】会话目录是「多代际」，不是一个文件
实测 12 个会话目录：
- 8 个只有 `session.v4.jsonl.zstd`
- **2 个只有 `session.v3.jsonl.zstd`**（`session-3dea30ef-…`、`session-4f544dff-…`）
- **2 个 v3 + v4 并存**（`session-473ff0ab-…`、`session-ec6f5fbe-…`）

原计划把路径写死成 `session.v4.jsonl.zstd`。后果：
- D1 只删 v4 文件 → **留下 v3 孤儿**，会话"删了还在"。
- D2b/D2c 重写错代际 → 改的不是当前生效的日志。

⇒ **M-1 必须先做代际解析**（索引器有 `readFirstZstdLine` / `resolveGenerationInDirectory` / `listSessionDirs` 可参照），并明确定义"删除一个会话"是删全部代际还是当前代际。

### C2. 【严重】缺少「M-1 安全基座」
原计划 M2 直接上手删文件，但 M2/M4/M5 全都依赖三个尚未定义的原语：原子重写（临时文件 + fsync + rename + `.bak`）、回收站、审计账本与回滚。**没有这层，任何一次写失败或校验不过都会留下半损坏的日志。**
已新增 M-1，并把「重写后必须过 `foldSurface` + `assertContiguous`，否则自动回滚」定成硬闸门。

### C3. 【中】回收站实现路径未定，且插件跑在 Node 里
插件是 Node 进程而非 PowerShell。`[待验证]` 三选一：
1. spawn `powershell -NoProfile` 调 `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(...,'SendToRecycleBin')` —— 最少代码，但依赖 `Microsoft.VisualBasic` 可用性与 spawn 权限。
2. 自行写 `C:\$Recycle.Bin\<SID>\` 的 `$I`/`$R` 对 —— 格式/权限风险高，不建议。
3. 不退回收站，自管 `.trash/` 目录 + 自写还原清单 —— 完全可控、可程序化还原，代价是"用户从资源管理器找不到"。
**倾向 3**（可控、可测、还原路径明确），M-1 实测后定案。
另外必须确定**程序化还原**方式（Shell.Application COM 或读自管清单）。

### C4. 【中】墓碑事件会扰动分页切点
分页计数只看 `MESSAGE_TYPES && isAppendSurfaceEvent`，切断点取 `groupStart`。墓碑事件若不计入计数，会让**分页边界移动**，历史加载出现重复或缺页。M0.5 的映射表必须显式覆盖这条，扰动器要把它作为断言之一。

### C5. 【中】多客户端同步未定义
线 A 的"已删除集合"若只存客户端本地，**另一标签页仍可见**，且刷新后行为不一致。需决定走投影 wire（宿主权威、跨端一致）还是 session event。倾向投影 wire，但要注意 `stateVersion` 纪律：语义变更必须 bump，否则持久缓存会前向套用成垃圾。

### C6. 【轻】`dsh.client` 新增条目不重启能否被发现，未验证
`ClientModuleRegistry` 增量扫描 `dsh.client` 是存在的，但 `bootInjections`/`WebBootGraph` 在启动期生成。M0 必须实测；且 HMR 免刷新只在 `pnpm run dev:web` 同时运行时成立。

### C7. 【轻】`inject` 清单是抄来的，需自证
`dsh-purge` 与 `turn-rewind` 的 inject 不同（后者还带了 `settingsScope`，而那正是它在本 profile 被禁用的原因）。**不要照抄 turn-rewind**。M0 必须用最小集实测收敛。

---

## D. 结论

原计划骨架正确、探针方法有效、风险意识足够。需要改的是三处：**新增 M-1**（C2）、**M-1/M2 加代际解析**（C1）、**M4 入口重新选型**（B2）。其余为补充约束，不影响里程碑顺序。

**建议顺序不变**：M-1 → M0（含探针 c/d）→ M0.5 → M1 → M2 → M3 → M4 → M5 →（M6 需重新论证）。
