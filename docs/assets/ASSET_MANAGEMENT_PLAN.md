# SelfCanvas 资产规模化管理优化方案

## 1. 目标与原则

SelfCanvas 当前已有“当前画布生成 / 历史生成 / 输出文件夹”三个入口、媒体落盘后的 `MediaArtifact`、文件管理器搜索与画布定位，以及 Codex MCP 的画布搜索、产物列表和下载能力。下一阶段不再让三个入口分别维护一套资产，而是建立统一资产索引：文件只保存一份，画布节点、生成任务、历史记录、集合和 Codex 都引用同一个 `assetId`。

核心原则：

- **统一索引，视图分离**：三个文件管理标签只是过滤视图，不是三份数据。
- **先索引再展示**：拖入、生成、剪辑、ZIP 导出等产物落盘后，必须先创建或复用资产记录，再写回节点。
- **不暴露路径**：浏览器与 MCP 仅接收不透明 `assetId` / `artifactId` 和受控预览、下载地址。
- **引用安全**：删除画布节点不等于删除文件；删除文件前必须检查节点、任务、集合、剪辑方案等引用。
- **大媒体轻量浏览**：原片用于渲染，缩略图、代理视频、音频波形用于搜索和预览。
- **可迁移、可回滚**：先旁路建索引并校验，再切换读取，最后迁移写入，旧项目在整个迁移期仍可加载。

## 2. 当前问题与目标体验

| 当前问题 | 目标体验 |
| --- | --- |
| 后拖入的图片、视频、音频只在某个画布位置存在，文件管理器不容易找到 | 拖入即入库；“未放置”“最近导入”“所在画布”可筛选；一键定位节点 |
| 同一文件被多次拖入或生成副本，占用空间且难以辨认 | 使用内容哈希识别重复文件，默认复用原资产，保留独立节点引用 |
| 资产一多，当前一次性加载和瀑布流会变慢 | 服务端游标分页、缩略图优先、前端虚拟列表和渐进加载 |
| 视频、音频预览成本高，缺少时长、帧率、波形等信息 | 后台生成低码率代理、海报帧和波形，原片保持不变 |
| 用户只能凭文件名查找 | 支持标签、集合、人物/场景/对白等 AI 元数据和自然语言搜索 |
| 任务显示完成但节点没有出现结果时，产物难追回 | 任务、资产、画布节点三方记录血缘；“未放置产物”可恢复到画布 |
| 清理文件容易误删仍被画布引用的素材 | 回收站、引用计数、删除影响预览、延迟物理删除和恢复机制 |

## 3. 统一数据模型

### 3.1 `AssetRecord`

建议在服务端新增持久化资产索引（首版可用原子 JSON，规模增大后迁移 SQLite/PostgreSQL）：

```ts
type AssetKind = 'image' | 'video' | 'audio' | 'archive' | 'other';
type AssetState =
  | 'indexing'
  | 'ready'
  | 'proxying'
  | 'failed'
  | 'archived'
  | 'trashed';

interface AssetRecord {
  assetId: string;             // 稳定、不透明，前端与 MCP 的主标识
  artifactId?: string;         // 当前 MediaArtifact 的受控下载标识
  projectId: string;
  kind: AssetKind;
  state: AssetState;

  displayName: string;
  originalName?: string;
  mimeType: string;
  size: number;
  contentHash: string;         // sha256:<hex>，只在服务端比较

  createdAt: string;
  updatedAt: string;
  importedAt?: string;
  generatedAt?: string;
  archivedAt?: string;
  trashedAt?: string;
  purgeAfter?: string;

  source: {
    type: 'upload' | 'drop' | 'generation' | 'video-edit' | 'zip-export' | 'migration';
    jobId?: string;
    provider?: string;
    model?: string;
    sourceAssetIds?: string[];
  };

  technical: {
    width?: number;
    height?: number;
    durationMs?: number;
    frameRate?: number;
    videoCodec?: string;
    audioCodec?: string;
    sampleRate?: number;
    channels?: number;
    hasAudio?: boolean;
  };

  derivatives: {
    thumbnailArtifactId?: string;
    posterArtifactId?: string;
    proxyArtifactId?: string;
    waveformArtifactId?: string;
    transcriptArtifactId?: string;
  };

  organization: {
    tagIds: string[];
    collectionIds: string[];
    favorite: boolean;
    rating?: 1 | 2 | 3 | 4 | 5;
  };

  ai: {
    status: 'none' | 'pending' | 'ready' | 'failed';
    summary?: string;
    people?: string[];
    scenes?: string[];
    objects?: string[];
    actions?: string[];
    dialogue?: string;
    language?: string;
    embeddingRef?: string;     // 只保存向量索引引用，不通过普通 API 返回向量
  };

  usage: {
    nodeRefCount: number;
    canvasRefCount: number;
    lastUsedAt?: string;
  };
}
```

`MediaArtifact` 继续负责安全预览/下载，`AssetRecord` 负责检索、组织、血缘和生命周期。两者通过 `artifactId` 关联，不能把绝对路径重新写入 `AssetRecord` 的公开响应。

### 3.2 引用与组织表

至少拆出以下关系，避免把不断增长的节点列表直接塞进 `AssetRecord`：

```ts
interface AssetReference {
  referenceId: string;
  assetId: string;
  projectId: string;
  canvasId?: string;
  nodeId?: string;
  jobId?: string;
  role: 'node-input' | 'node-output' | 'edit-source' | 'download-export';
  createdAt: string;
}

interface AssetCollection {
  collectionId: string;
  projectId: string;
  name: string;
  description?: string;
  color?: string;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
}

interface AssetTag {
  tagId: string;
  projectId: string;
  name: string;
  color?: string;
  source: 'user' | 'ai';
}
```

“未放置”不需要复制资产：定义为 `state=ready` 且当前项目中不存在 `node-output` / `node-input` 画布引用的资产。“任务完成但节点丢失”的视频会自然进入该视图，用户可以选择“放回原画布”或“创建新视频节点”。

## 4. 资源处理流水线

### 4.1 导入与生成写入

所有入口统一执行：

1. 接收或拉取文件到隔离的临时目录。
2. 校验 MIME、扩展名、大小、媒体头和目标目录边界。
3. 流式计算 SHA-256，并用 `projectId + contentHash + size` 查询重复资产。
4. 若命中且原文件可用：复用 `assetId`，只新增节点/任务引用；允许用户选择“保留独立副本”。
5. 若未命中：原子移动到受控输出目录，创建 `MediaArtifact` 与 `AssetRecord(state=indexing)`。
6. 使用 `ffprobe` / 图片元数据解析器写入技术信息。
7. 异步生成缩略图、代理、波形；完成后置为 `ready`。
8. 生成任务先写资产，再以 CAS 检查 `lastJobId` 后写回节点；CAS 失败时保留资产为“未放置”，不能丢弃结果。

### 4.2 内容哈希与去重边界

- 完全一致文件：SHA-256 相同，默认物理文件只保留一份。
- 转码后画面相似但字节不同：首版不自动合并，只显示“疑似重复”；后续可使用感知哈希/音频指纹。
- 用户重命名、打标签、加入集合只修改资产元数据，不改原文件哈希。
- 已进入回收站但尚未清除的资产仍参与去重；新导入命中时恢复它并新增引用。
- 衍生文件（缩略图、代理、波形）以 `parentAssetId + derivativeType + pipelineVersion` 去重，处理规则升级时可安全重建。

### 4.3 视频、音频代理与波形

后台媒体处理队列与生成队列、视频渲染队列分离：

- 图片：生成 WebP/JPEG 小、中两档缩略图，并尊重 EXIF 方向。
- 视频：生成海报帧和 360p/540p H.264/AAC MP4 代理；原片只在下载和最终 FFmpeg 渲染时使用。
- 音频：生成低码率试听文件、峰值波形 JSON（分层采样）和可选声谱图缩略图。
- 长视频：先生成关键帧和低码率代理，再异步进行内容理解；不得阻塞资产列表可见性。
- 失败处理：原片可用时资产保持可下载，衍生状态单独标记失败并允许重试。

## 5. 文件管理器信息架构

### 5.1 保留现有标签，统一为查询视图

- **当前画布生成**：当前 `canvasId` 下有引用的资产，按最近使用排序。
- **历史生成**：`source.type` 为生成/剪辑的资产，支持按任务状态、模型和日期过滤。
- **输出文件夹**：所有已落盘且可下载的资产，不直接暴露真实目录。
- **新增“未放置”**：任务成功但未绑定节点、上传后尚未拖入画布的资产。
- **新增“收藏 / 集合 / 回收站”**：作为左侧分组或可折叠区域，避免继续增加顶部标签数量。

### 5.2 服务端分页与前端虚拟列表

- 列表 API 使用不透明 `cursor`，不要使用会因新增数据产生跳页的页码偏移。
- 默认 `limit=60`，允许 20–100；返回 `nextCursor`、`hasMore` 和各媒体类型聚合计数。
- 搜索、筛选、排序全部在服务端执行；浏览器只持有当前窗口和已选中的 `assetId`。
- 网格使用行/列虚拟化，只渲染可视区域及前后 1–2 屏；图片采用缩略图和懒加载。
- 多选跨页时保存 `selectedAssetIds`，若采用“选择全部查询结果”，保存 `querySnapshot + excludedIds`，避免把数万个 ID 发回浏览器。
- 列表查询使用 250–350ms 防抖，切换查询时取消旧请求，响应必须携带查询版本防止乱序覆盖。

### 5.3 搜索与筛选

基础字段：文件名、节点标题、提示词/脚本文本、模型、提供商、任务号、标签、集合、人物、场景、日期、尺寸、时长、是否含音轨、是否已放置。

推荐筛选组合：

- 类型：图像 / 视频 / 音频 / 压缩包。
- 来源：拖入 / 上传 / 图片生成 / 视频生成 / AI 剪辑 / 直接合并。
- 状态：处理中 / 可用 / 处理失败 / 未放置 / 已归档 / 回收站。
- 使用范围：当前画布 / 其他画布 / 从未使用。
- 质量：横竖比、分辨率、时长、评分、收藏。
- 时间：今天 / 7 天 / 30 天 / 自定义。

## 6. AI 与 Codex 搜索定位

### 6.1 统一检索行为

用户说“找到昨晚生成的雨夜茶铺视频”“定位沈照雪那张人物图”时：

1. 先结构化解析类型、时间、人物、场景、来源等过滤条件。
2. 精确检索文件名、标签、节点/任务关联和提示词。
3. 精确结果不足时，再执行 AI 元数据或向量语义检索。
4. 返回最多 5 个候选，含缩略图、所在画布、创建时间和来源；唯一高置信结果可直接定位。
5. 定位操作先切换到目标画布，再聚焦节点并闪烁高亮；未放置资产则打开资产详情并提供“放到画布”。

### 6.2 MCP 扩展建议

复用现有 `canvas_search_nodes`、`canvas_apply_operations(focus_node)`、`canvas_list_artifacts` 和 `canvas_prepare_download`，新增资产级工具：

- `canvas_search_assets`：自然语言或结构化条件搜索资产，分页返回受控摘要。
- `canvas_get_asset`：读取单个资产的技术信息、血缘、引用位置和可用衍生文件。
- `canvas_focus_asset`：若有画布引用，切换并聚焦指定节点；否则返回未放置状态。
- `canvas_organize_assets`：批量加标签、加入集合或收藏，必须带 `requestId`。
- `canvas_place_asset`：把未放置资产放到指定画布坐标，写操作带 `baseRevision`。

Codex 不得取得绝对路径、文件正文、API Key、任意 URL 或任意命令执行权。搜索与读取可自动执行；新增节点、批量修改组织信息、下载打包需要遵守客户端确认策略；永久清除资产首版不向 MCP 开放。

## 7. API 草案

保持现有 `/api/v2/canvases/*`、`/api/v2/downloads` 和 `/api/exports` 兼容，新增：

```http
GET  /api/v2/assets?canvasId=&kind=&state=&source=&collectionId=&tagId=
                    &favorite=&unplaced=&q=&sort=&cursor=&limit=
GET  /api/v2/assets/{assetId}
GET  /api/v2/assets/{assetId}/references
GET  /api/v2/assets/facets?q=&canvasId=

POST /api/v2/assets/search
POST /api/v2/assets/{assetId}/focus
POST /api/v2/assets/{assetId}/place
POST /api/v2/assets/batch-organize

POST /api/v2/assets/{assetId}/archive
POST /api/v2/assets/{assetId}/restore
POST /api/v2/assets/{assetId}/trash
POST /api/v2/assets/{assetId}/restore-from-trash
POST /api/v2/assets/{assetId}/purge

GET  /api/v2/collections
POST /api/v2/collections
PATCH /api/v2/collections/{collectionId}
GET  /api/v2/tags
POST /api/v2/tags
```

分页响应：

```json
{
  "items": [],
  "nextCursor": "opaque-cursor",
  "hasMore": true,
  "facets": {
    "image": 1520,
    "video": 238,
    "audio": 91,
    "unplaced": 12
  }
}
```

写操作请求统一包含：

```json
{
  "requestId": "stable-idempotency-key",
  "baseRevision": 42,
  "assetIds": ["asset_opaque"],
  "operation": {}
}
```

冲突返回 409，并携带最新 revision；重复 `requestId` 返回首次执行结果，不能重复放置节点或重复创建付费任务。

## 8. 生命周期、归档与删除安全

1. **活跃**：可搜索、预览、引用、下载和渲染。
2. **归档**：默认搜索隐藏，但引用仍有效；原片保留，代理可按磁盘策略重建。
3. **回收站**：默认保留 30 天；现有节点显示“资产在回收站”但仍可恢复，不立即断链。
4. **物理清除**：仅当无活跃引用，或用户看过影响列表并明确确认后执行；清除原片、衍生文件和索引。

删除前服务端必须返回：引用画布数、节点数、剪辑方案数、任务数和预计释放空间。批量删除采用“先移入回收站”，首版 UI 不提供绕过回收站的快捷键。正在生成、下载打包或 FFmpeg 渲染的资产禁止物理清除。

磁盘策略建议：

- 高水位 80% 提醒，90% 暂停新的大文件生成或上传。
- 优先清理过期临时文件、失败任务中间文件和可重建代理，不自动删除原片。
- 定期扫描“索引有记录但文件丢失”和“文件存在但无索引”两类异常，生成只读修复报告后再处理。

## 9. 迁移与交付阶段

### 阶段 0：基线与保护（1–2 天）

- 备份项目状态、输出目录和 `.runtime`。
- 统计文件数、总容量、重复率、孤儿文件、缺失文件和最大单文件。
- 给现有 `MediaArtifact`、任务、画布节点补充稳定关联字段，但保持旧读写接口。
- 建立迁移开关：`ASSET_INDEX_READ_ENABLED`、`ASSET_INDEX_WRITE_ENABLED`。

### 阶段 1：旁路索引（3–5 天）

- 扫描受控输出目录和所有画布，创建 `AssetRecord` / `AssetReference`。
- 使用断点游标批处理，每批 200–500 个文件；每批写审计日志，可安全重跑。
- 先按路径、大小、mtime 建快速清单，再异步计算 SHA-256，避免长时间阻塞启动。
- 双写新导入/新生成资产到旧项目结构和新索引；UI 仍从旧结构读取。

### 阶段 2：统一查询与新文件管理器（4–7 天）

- 切换文件管理器到资产分页 API，接入虚拟列表、未放置、收藏、集合、标签和引用定位。
- 旧三个标签转换成服务端查询条件。
- 接入任务成功但节点写回冲突时的“未放置产物”恢复流程。
- 灰度开启新读取；发现索引差异时可立即切回旧读取。

### 阶段 3：衍生媒体与去重（4–7 天）

- 部署独立媒体处理 worker，生成图片缩略图、视频代理/海报和音频波形。
- 启用 SHA-256 物理去重，新文件先校验后落盘；旧重复文件只报告，不自动合并。
- 增加衍生文件版本和重建命令，验证原片始终用于最终渲染。

### 阶段 4：AI/Codex 搜索定位（3–6 天）

- 先开放结构化搜索和 `canvas_focus_asset`，再增加 AI 摘要/标签和语义索引。
- 接入 MCP 资产工具，复用 Bearer Token、权限范围、CAS 和幂等。
- 对“自动定位”设置置信阈值；低置信时展示候选，不随意跳画布。

### 阶段 5：生命周期与规模化运维（3–5 天）

- 上线归档、回收站、引用影响预览和延迟清除。
- 增加磁盘水位、处理队列、失败率、孤儿资产和索引一致性监控。
- 数据稳定一轮发布周期后，才停止旧写入；旧读取兼容至少保留一个版本。

## 10. 验收指标

### 功能正确性

- 新拖入/上传/生成的图片、视频、音频 100% 可在 2 秒内进入资产列表（衍生媒体可继续后台处理）。
- 任务成功但节点写回失败时，100% 在“未放置”中可找回并重新放置。
- 相同字节文件重复导入 100 次只产生 1 份物理原片、100 个合法引用。
- 定位资产后切换到正确画布，节点进入视口中心并有明确高亮。
- 物理清除存在引用的资产必须被拒绝或要求显式影响确认。

### 性能基线

- 10 万条资产索引下，常规列表查询 P95 < 300ms，文本/标签组合搜索 P95 < 800ms。
- 首屏 60 个资产在局域网环境 1.5 秒内可交互；滚动过程中可见区不超过约 150 个真实 DOM 卡片。
- 缩略图/代理失败不阻塞原片下载；长视频代理处理不占用图片/视频生成队列。
- 单个画布 5,000 个节点、项目 50,000 个资产时，定位操作 P95 < 1 秒（不含首次画布资源加载）。

### 数据与安全

- 迁移前后资产总数、总字节、各类型数量和节点引用数差异为 0，差异必须有审计解释。
- 路径穿越、伪造 `assetId`、跨项目访问、绝对路径和任意 URL 请求全部被拒绝。
- 重复 MCP `requestId` 不产生重复节点、重复组织操作或重复付费任务。
- 30 天回收站恢复成功率 100%；清除任务中断后可重试且不会误删其他资产。

## 11. 推荐的首个迭代范围

首个可交付迭代只做高收益闭环：

1. `AssetRecord` / `AssetReference` 旁路索引与迁移扫描器。
2. 分页资产 API、文件管理器虚拟列表和“未放置”视图。
3. 新导入与生成结果的 SHA-256 去重，以及任务完成但节点丢失的资产追回。
4. 图片缩略图、视频海报/代理、音频波形的独立处理队列。
5. `canvas_search_assets`、`canvas_focus_asset` 和 `canvas_place_asset` MCP 工具。
6. 收藏、标签、集合、归档和回收站；永久清除暂不开放给 Codex。

这个范围完成后，资产数量增长不会继续放大“找不到、重复占空间、任务完成却看不见、误删引用”的问题，并为后续人物/场景语义搜索和更完整的媒体制作工作流提供稳定底座。
