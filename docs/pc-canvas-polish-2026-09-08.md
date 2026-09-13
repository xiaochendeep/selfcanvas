# PC 画布：AnyCap 模型与资产库优化

## 本轮实现

- 对照 2026-09-08 AnyCap 官方实时 models/schema 保存 28 个模型：8 图片、15 视频、1 豆包音频、4 音乐。审计来源见 `anycap/catalog-2026-09-08.md`。
- 前端通过能力接口同步模型，支持搜索、手动刷新、带日期的离线目录。保留旧节点选中的模型，不因目录刷新静默替换。
- Seedance 2.5 支持 5–30 秒及首尾帧；MiniMax H3 支持 2K、5–15 秒。引用上限、比例、时长、声音开关按具体模式获取。
- 豆包使用原生 audio 路由，语速、音调、响度、音色 ID、采样率、字幕与输出格式透传；音乐使用 music 路由并处理秒/毫秒转换。旧音乐 style 迁移至 tags。
- 音频弹窗补齐可见标签、全宽输入与滑杆；弹窗根据上方可用空间滚动，避免顶部截断。
- 资产和文件管理统一为资产库：当前画布/全部画布/输出文件夹、关键词/来源/类型筛选、真实排序、跨画布去重与定位、36 项分页、固定批量下载底栏。
- 图片保持完整比例；视频只在卡片进入可见区域后加载首帧，不自动播放，离屏卸载。

## Figma

UbiquantPartners 下的可编辑设计稿：

[SelfCanvas PC · Models & Assets](https://www.figma.com/design/SQmnPuzHOhlQHZ3MzWcwc4)

- 资产库：`5:939`
- AnyCap 视频/音频交互与模型选择：`6:51`

使用组织 Shadcn UI 组件与深色变量、真实资产缩略图进行设计校对；保留原画布数据。Figma 捕获工具只在开发模式且 URL 显式带 `figmacapture` 时加载，生产环境不会加载它。

## 验证

- 生产构建通过；仍有单 JS bundle 超过 500KB 的提示。
- `node --test tests/anycap_catalog.test.ts tests/asset_browser.test.ts`：11/11。
- `npm run test:media`：16/16，包含无付费的 CLI 请求级模拟。
- `python3 -m unittest discover -s tests -p 'test_*.py'`：22/22。
- 本机浏览器实际检查：15 个视频、8 个图片、5 个音频/音乐目录；H3 多参考无声音开关、图生视频有声音开关；H3 时长 5–15 秒；豆包参数标签；Suno 自定义歌词编辑；资产按类型筛选。
- 开发隔离页面：`http://localhost:5190/tests/pc-ui-harness.html`。不启动项目同步，所有生成/写接口被阻止，组件状态改动只在内存。不要将该页面视为真实生成结果。

## 边界

- 未进行付费生成、Windows 部署或 GitHub 提交。
- 当前机器访问 AnyCap API 存在网络/域名解析问题，目录已通过官方公开接口核实并提供快照兜底；需要连接恢复后再做真实生成验收。
- 本轮未启动 media worker / video edit worker，避免运行已有排队任务；本机前端与 API 已启动。
- 当前浏览器已有画布同步冲突提示，本轮没有选择覆盖、重置或恢复画布。
- 资产分页为前端分页，文件接口仍返回现有全量索引；未增加标签/收藏的持久化系统。
