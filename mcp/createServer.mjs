import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { safeErrorPayload } from './security.mjs';
import { SelfCanvasClient } from './selfCanvasClient.mjs';

export const SELF_CANVAS_MCP_VERSION = '1.0.0';
export const ALL_SCOPES = Object.freeze([
  'canvas:read',
  'canvas:write',
  'generation:read',
  'generation:run',
  'artifacts:read',
  'artifacts:download',
]);

const NodeKindSchema = z.enum([
  'text',
  'image',
  'video',
  'audio',
  'stage3d',
  'panorama',
  'storyboard',
  'collage',
  'asset',
  'upload',
]);
const ArtifactTypeSchema = z.enum(['image', 'video', 'audio', 'other']);
const IdentifierSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/, 'ID 格式无效');
const ArtifactIdentifierSchema = z
  .string()
  .trim()
  .min(26)
  .max(4_096)
  .regex(/^[A-Za-z0-9_-]+\.[a-f0-9]{24}$/, 'artifactId 格式无效');
const RequestIdSchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'requestId 格式无效');
const CursorSchema = z.string().max(1_024).optional();
const LimitSchema = z.number().int().min(1).max(50).default(20);
const PositionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const ViewportSchema = z
  .object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().finite().min(0.05).max(8) })
  .strict();
const ScalarOptionSchema = z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()]);
const ProviderOptionsSchema = z
  .record(z.string().min(1).max(80), ScalarOptionSchema)
  .refine((value) => Object.keys(value).length <= 80, 'providerOptions 字段过多')
  .refine(
    (value) =>
      Object.entries(value).every(
        ([key, item]) =>
          !/(?:url|path|endpoint|command|args|token|api.?key|access.?key|secret|password)$/i.test(key) &&
          !(typeof item === 'string' && /^(?:https?:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|var|tmp|mnt)\/)/i.test(item)),
      ),
    'providerOptions 不允许 URL、本地路径、命令或密钥字段',
  );

const NewNodeSchema = z
  .object({
    id: IdentifierSchema.optional(),
    kind: NodeKindSchema,
    title: z.string().trim().min(1).max(200),
    prompt: z.string().max(20_000).default(''),
    position: PositionSchema,
    provider: z.string().max(100).optional(),
    model: z.string().max(200).optional(),
    providerOptions: ProviderOptionsSchema.optional(),
  })
  .strict();

const NodePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().max(20_000).optional(),
    provider: z.string().max(100).optional(),
    model: z.string().max(200).optional(),
    providerOptions: ProviderOptionsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'patch 不能为空');

const BindReferencesOperationSchema = z
  .object({
    type: z.literal('bind_references'),
    targetNodeId: IdentifierSchema,
    sourceNodeIds: z.array(IdentifierSchema).min(1).max(9),
    ensureEdges: z.boolean().default(true),
    appendMentions: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.sourceNodeIds).size !== value.sourceNodeIds.length) {
      context.addIssue({ code: 'custom', path: ['sourceNodeIds'], message: 'sourceNodeIds 不可重复' });
    }
    if (value.sourceNodeIds.includes(value.targetNodeId)) {
      context.addIssue({ code: 'custom', path: ['sourceNodeIds'], message: '不能将节点引用到自身' });
    }
  });

const CanvasOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rename_canvas'), name: z.string().trim().min(1).max(120) }).strict(),
  z.object({ type: z.literal('add_node'), node: NewNodeSchema }).strict(),
  z.object({ type: z.literal('update_node'), nodeId: IdentifierSchema, patch: NodePatchSchema }).strict(),
  BindReferencesOperationSchema,
  z.object({ type: z.literal('move_node'), nodeId: IdentifierSchema, position: PositionSchema }).strict(),
  z
    .object({ type: z.literal('add_edge'), sourceNodeId: IdentifierSchema, targetNodeId: IdentifierSchema })
    .strict()
    .refine((value) => value.sourceNodeId !== value.targetNodeId, '不能连接节点自身'),
  z.object({ type: z.literal('set_viewport'), viewport: ViewportSchema }).strict(),
  z.object({ type: z.literal('focus_node'), nodeId: IdentifierSchema }).strict(),
]);

const VideoOutputSchema = z
  .object({
    resolution: z.enum(['480p', '720p', '1080p', '4k']).optional(),
    aspectRatio: z.enum(['adaptive', '16:9', '9:16', '4:3', '3:4', '1:1', '21:9']).optional(),
    fps: z.number().int().min(12).max(60).optional(),
    format: z.literal('mp4').optional(),
  })
  .strict();

const VideoEditInputSchema = z
  .object({
    canvasId: IdentifierSchema,
    baseRevision: z.number().int().min(0),
    requestId: RequestIdSchema,
    mode: z.enum(['ai_edit', 'merge', 'creative']),
    sourceNodeIds: z.array(IdentifierSchema).min(1).max(20),
    targetNodeId: IdentifierSchema.optional(),
    prompt: z.string().max(20_000).optional(),
    transition: z.enum(['cut', 'crossfade']).default('cut'),
    audioPolicy: z.enum(['preserve', 'mute', 'normalize']).default('preserve'),
    output: VideoOutputSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'creative' && value.sourceNodeIds.length > 3) {
      context.addIssue({ code: 'custom', path: ['sourceNodeIds'], message: '创意改编仅支持 1–3 段视频' });
    }
    if (value.mode !== 'creative' && value.sourceNodeIds.length < 2) {
      context.addIssue({ code: 'custom', path: ['sourceNodeIds'], message: 'AI 剪辑和直接合并至少需要 2 段视频' });
    }
    if (new Set(value.sourceNodeIds).size !== value.sourceNodeIds.length) {
      context.addIssue({ code: 'custom', path: ['sourceNodeIds'], message: 'sourceNodeIds 不可重复' });
    }
  });

const ToolOutputSchema = z.object({ result: z.unknown() });

const CreativeDraftInputSchema = z.object({
  kind: z.enum(['script', 'storyboard', 'video-analysis']),
  canvasId: IdentifierSchema,
  requestId: RequestIdSchema,
  confirmed: z.literal(true),
  brief: z.string().max(8_000).optional(),
  sourceText: z.string().max(40_000).optional(),
  shotCount: z.number().int().min(1).max(20).optional(),
  durationSeconds: z.number().int().min(5).max(600).optional(),
  aspectRatio: z.enum(['9:16', '16:9', '1:1']).optional(),
  style: z.string().max(1_000).optional(),
  imageModel: IdentifierSchema.optional(),
  videoModel: IdentifierSchema.optional(),
  sourceNodeId: IdentifierSchema.optional(),
}).strict().superRefine((input, context) => {
  if (input.kind === 'video-analysis') {
    if (!input.sourceNodeId) context.addIssue({ code: 'custom', path: ['sourceNodeId'], message: '视频分析需要当前画布中的视频节点 ID' });
  } else {
    if (!input.brief?.trim() && !input.sourceText?.trim()) context.addIssue({ code: 'custom', path: ['brief'], message: '请提供创作需求或原始剧本' });
    if (input.sourceNodeId) context.addIssue({ code: 'custom', path: ['sourceNodeId'], message: '仅视频分析接受视频节点引用' });
  }
});

const READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
});
const GENERATION_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});
const ADDITIVE_LOCAL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

class ScopeError extends Error {
  constructor(scope) {
    super(`MCP Token 缺少权限：${scope}`);
    this.code = 'insufficient_scope';
    this.status = 403;
  }
}

export function parseScopes(raw = process.env.SELF_CANVAS_MCP_SCOPES) {
  if (!String(raw || '').trim() || String(raw).trim() === '*') return new Set(ALL_SCOPES);
  const scopes = new Set(String(raw).split(/[\s,]+/).map((item) => item.trim()).filter(Boolean));
  const unknown = [...scopes].filter((scope) => !ALL_SCOPES.includes(scope));
  if (unknown.length) throw new TypeError(`未知 SELF_CANVAS_MCP_SCOPES：${unknown.join(', ')}`);
  return scopes;
}

function toolSuccess(result) {
  const structuredContent = { result };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toolFailure(error) {
  const payload = safeErrorPayload(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function register(server, scopes, definition, handler) {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: ToolOutputSchema,
      annotations: definition.annotations,
    },
    async (input) => {
      try {
        for (const scope of definition.scopes) {
          if (!scopes.has(scope)) throw new ScopeError(scope);
        }
        return toolSuccess(await handler(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'canvas_list_canvases',
    title: '列出 SelfCanvas 画布',
    description: '分页列出画布名称、ID、revision 和更新时间。写入前先调用此工具取得画布 ID。',
    inputSchema: z.object({ cursor: CursorSchema, limit: LimitSchema }).strict(),
    annotations: READ_ANNOTATIONS,
    scopes: ['canvas:read'],
    call: (api, input) => api.listCanvases(input),
  },
  {
    name: 'canvas_get_canvas',
    title: '读取 SelfCanvas 画布',
    description: '读取指定画布及当前 revision；节点较多时使用 nextCursor 逐页读取。',
    inputSchema: z.object({ canvasId: IdentifierSchema, cursor: CursorSchema, limit: LimitSchema }).strict(),
    annotations: READ_ANNOTATIONS,
    scopes: ['canvas:read'],
    call: (api, input) => api.getCanvas(input),
  },
  {
    name: 'canvas_search_nodes',
    title: '搜索 SelfCanvas 节点',
    description: '按文字和文件类型搜索画布节点，返回受控节点 ID；不会返回本地绝对路径。',
    inputSchema: z
      .object({
        canvasId: IdentifierSchema,
        query: z.string().trim().max(500).optional(),
        kinds: z.array(NodeKindSchema).max(10).optional(),
        cursor: CursorSchema,
        limit: LimitSchema,
      })
      .strict(),
    annotations: READ_ANNOTATIONS,
    scopes: ['canvas:read'],
    call: (api, input) => api.searchNodes(input),
  },
  {
    name: 'canvas_apply_operations',
    title: '修改 SelfCanvas 画布',
    description:
      '以 CAS 方式批量添加或修改画布内容。bind_references 只接收画布节点 ID，可把 1–9 个已有素材绑定到目标节点；也可用 focus_node 让打开的浏览器聚焦指定节点。必须传 canvas_get_canvas 返回的 baseRevision 和稳定 requestId；不支持删除。',
    inputSchema: z
      .object({
        canvasId: IdentifierSchema,
        baseRevision: z.number().int().min(0),
        requestId: RequestIdSchema,
        operations: z.array(CanvasOperationSchema).min(1).max(50),
      })
      .strict(),
    annotations: WRITE_ANNOTATIONS,
    scopes: ['canvas:write'],
    call: (api, input) => api.applyOperations(input),
  },
  {
    name: 'canvas_run_node',
    title: '运行 SelfCanvas 节点',
    description:
      '运行现有节点并创建后台生成任务，可能调用付费 AI 服务。重试时复用同一个 requestId，随后用 canvas_get_job 查询。',
    inputSchema: z
      .object({
        canvasId: IdentifierSchema,
        nodeId: IdentifierSchema,
        baseRevision: z.number().int().min(0),
        requestId: RequestIdSchema,
      })
      .strict(),
    annotations: GENERATION_ANNOTATIONS,
    scopes: ['generation:run'],
    call: (api, input) => api.runNode(input),
  },
  {
    name: 'canvas_create_video_edit',
    title: '创建 SelfCanvas 视频剪辑',
    description:
      '按 sourceNodeIds 顺序创建 AI 剪辑、直接合并或创意改编任务。AI/创意模式可能调用付费服务；返回任务 ID 后轮询。',
    inputSchema: VideoEditInputSchema,
    annotations: GENERATION_ANNOTATIONS,
    scopes: ['generation:run'],
    call: (api, input) => api.createVideoEdit(input),
  },
  {
    name: 'canvas_get_job',
    title: '查询 SelfCanvas 任务',
    description: '查询生成、视频剪辑或 ZIP 打包任务的状态和进度。',
    inputSchema: z.object({ jobId: IdentifierSchema }).strict(),
    annotations: READ_ANNOTATIONS,
    scopes: ['generation:read'],
    call: (api, input) => api.getJob(input),
  },
  {
    name: 'canvas_list_artifacts',
    title: '列出 SelfCanvas 产物',
    description: '分页列出画布中已经落盘的图片、视频和音频产物；仅返回文件 ID 与受控下载地址。',
    inputSchema: z
      .object({
        canvasId: IdentifierSchema,
        nodeId: IdentifierSchema.optional(),
        types: z.array(ArtifactTypeSchema).max(4).optional(),
        cursor: CursorSchema,
        limit: LimitSchema,
      })
      .strict(),
    annotations: READ_ANNOTATIONS,
    scopes: ['artifacts:read'],
    call: (api, input) => api.listArtifacts(input),
  },
  {
    name: 'canvas_prepare_download',
    title: '准备 SelfCanvas 下载',
    description:
      '为一个产物准备下载，或把多个产物异步打包为 ZIP。只接受 canvas_list_artifacts 返回的不透明 artifactId。',
    inputSchema: z
      .object({
        canvasId: IdentifierSchema,
        artifactIds: z.array(ArtifactIdentifierSchema).min(1).max(100),
        archiveName: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .refine((value) => !/[\\/\0]/.test(value) && value !== '.' && value !== '..', 'archiveName 不能包含路径')
          .optional(),
        requestId: RequestIdSchema,
      })
      .strict()
      .refine((value) => new Set(value.artifactIds).size === value.artifactIds.length, {
        path: ['artifactIds'],
        message: 'artifactIds 不可重复',
      }),
    annotations: ADDITIVE_LOCAL_ANNOTATIONS,
    scopes: ['artifacts:download'],
    call: (api, input) => api.prepareDownload(input),
  },
  {
    name: 'canvas_get_creative_capabilities',
    title: '读取 SelfCanvas 创作助手能力',
    description: '读取已配置的一键剧本、图片分镜、视频分析能力与模型及限制；不调用生成模型，不收费。先检查对应能力是否可用。',
    inputSchema: z.object({}).strict(),
    annotations: READ_ANNOTATIONS,
    scopes: ['canvas:read'],
    call: (api) => api.getCreativeCapabilities(),
  },
  {
    name: 'canvas_create_creative_draft',
    title: '生成 SelfCanvas 创作草稿',
    description: '调用已配置网关生成剧本、分镜或视频分析草稿，可能收费，必须先获得用户对本次调用的确认并传 confirmed:true。视频分析只接受当前画布 sourceNodeId。仅返回候选稿，不创建或修改画布节点，也不生成图片或视频。保留 sourceRevision 供后续检查。重试须复用相同 requestId 和参数；超时或连接中断后结果不确定，禁止用新 ID 自动重跑。',
    inputSchema: CreativeDraftInputSchema,
    annotations: GENERATION_ANNOTATIONS,
    scopes: ['generation:run'],
    call: (api, input) => api.createCreativeDraft(input),
  },
]);

export function createSelfCanvasMcpServer(options = {}) {
  const api = options.apiClient || new SelfCanvasClient(options);
  const scopes = options.scopes instanceof Set ? options.scopes : parseScopes(options.scopes);
  const server = new McpServer(
    { name: 'selfcanvas', version: SELF_CANVAS_MCP_VERSION },
    {
      instructions:
        '先列出并读取画布，写操作必须使用最新 revision 和稳定 requestId；409 后重新读取，禁止盲目覆盖。生成和 AI 剪辑可能产生费用，遵循客户端确认策略。素材只用节点 ID 或 artifactId，不传本地路径、外部 URL 或密钥。任务完成前用 canvas_get_job 轮询；下载前先 canvas_list_artifacts。创作助手先读取能力；生成草稿需要用户确认与 confirmed:true，草稿不写画布、不运行媒体生成。创作请求超时须保留原 requestId，禁止换 ID 自动重试。用户接受草稿后再读取当前 revision 并用画布写操作导入。删除能力未开放。',
    },
  );

  for (const definition of TOOL_DEFINITIONS) {
    register(server, scopes, definition, (input) => definition.call(api, input));
  }
  return server;
}
