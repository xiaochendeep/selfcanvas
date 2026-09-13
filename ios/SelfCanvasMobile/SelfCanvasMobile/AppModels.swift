import Foundation

enum AppTab: String, CaseIterable, Identifiable {
    case create
    case projects
    case tasks
    case assets

    var id: String { rawValue }

    var title: String {
        switch self {
        case .create: "创作"
        case .projects: "项目"
        case .tasks: "任务"
        case .assets: "资产"
        }
    }

    var symbol: String {
        switch self {
        case .create: "sparkles"
        case .projects: "rectangle.3.group"
        case .tasks: "checklist"
        case .assets: "folder"
        }
    }
}

enum GenerationMode: String, CaseIterable, Identifiable, Codable {
    case director = "AI 导演"
    case image = "图片"
    case video = "视频"
    case audio = "音频"

    var id: String { rawValue }

    var kind: String {
        switch self {
        case .director: "storyboard"
        case .image: "image"
        case .video: "video"
        case .audio: "audio"
        }
    }

    var model: String {
        switch self {
        case .director: "gpt-5.5"
        case .image: "nano-banana-2"
        case .video: "seedance-2-fast"
        case .audio: "doubao-seed-audio-1-0"
        }
    }

    var symbol: String {
        switch self {
        case .director: "wand.and.stars"
        case .image: "photo"
        case .video: "video"
        case .audio: "waveform"
        }
    }
}

enum VideoOperation: String, CaseIterable, Identifiable, Codable {
    case generate
    case aiEdit = "ai-edit"
    case concat
    case creativeEdit = "creative-edit"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .generate: "生成视频"
        case .aiEdit: "AI 剪辑"
        case .concat: "直接合并"
        case .creativeEdit: "创意改编"
        }
    }

    var subtitle: String {
        switch self {
        case .generate: "根据提示词生成新视频"
        case .aiEdit: "分析素材并生成剪辑方案"
        case .concat: "严格按照素材顺序拼接"
        case .creativeEdit: "使用 AnyCap 重构 1–3 段视频"
        }
    }

    var referenceRange: ClosedRange<Int>? {
        switch self {
        case .generate: nil
        case .aiEdit, .concat: 2...20
        case .creativeEdit: 1...3
        }
    }
}

struct SessionCredential: Codable, Equatable {
    let serverURL: String
    let username: String
    let accessToken: String
    let refreshToken: String
    let expiresAt: String
}

struct AuthUserDTO: Codable, Equatable {
    let id: String
    let username: String
    let roles: [String]
}

struct AuthSessionDTO: Codable, Equatable {
    let tokenType: String
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int
    let expiresAt: String
    let user: AuthUserDTO
}

struct MobileCapabilitiesDTO: Codable, Equatable {
    let apiVersion: String
    let models: MobileModelCatalogDTO
    let features: MobileFeatureFlagsDTO
    let status: MobileBackendStatusDTO
}

struct MobileModelCatalogDTO: Codable, Equatable {
    let director: String
    let image: String
    let video: String
    let audio: String
    let creativeVideo: String
}

struct MobileFeatureFlagsDTO: Codable, Equatable {
    let mediaGeneration: Bool
    let videoEditing: Bool
    let codexMcp: Bool
    let downloads: Bool
    let assetSearch: Bool
}

struct MobileBackendStatusDTO: Codable, Equatable {
    let mediaQueue: BackendQueueStatusDTO
    let videoEditQueue: BackendQueueStatusDTO
}

struct BackendQueueStatusDTO: Codable, Equatable {
    let available: Bool
    let reason: String
}

struct CanvasSummary: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let nodeCount: Int
    let edgeCount: Int
    let updatedAt: String
    let active: Bool
}

struct CanvasesEnvelope: Codable {
    let projectId: String
    let revision: Int
    let canvases: [CanvasSummary]
    let nextCursor: String?
}

struct CanvasDetailEnvelope: Codable {
    let projectId: String
    let revision: Int
    let canvas: CanvasHeader
    let nodes: [CanvasNodeDTO]
    let nextCursor: String?
}

struct CanvasHeader: Codable {
    let id: String
    let name: String
    let updatedAt: String
}

struct CanvasNodeDTO: Codable, Identifiable, Hashable {
    let id: String
    let data: CanvasNodeDataDTO
}

struct CanvasNodeDataDTO: Codable, Hashable {
    let kind: String
    let title: String
    let prompt: String?
    let status: String?
    let progress: Double?
    let error: String?
}

struct GenerationJobDTO: Codable, Identifiable, Hashable {
    let id: String
    let nodeId: String?
    let targetNodeId: String?
    let kind: String
    let title: String?
    let provider: String
    let model: String
    let status: String
    let progress: Double
    let prompt: String
    let error: String?
    let createdAt: String
    let updatedAt: String
    let result: JobResultDTO?

    var displayTitle: String {
        let clean = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return clean.isEmpty ? "\(kind.capitalized) · \(model)" : clean
    }

    var isFinished: Bool { status == "success" || status == "error" || status == "canceled" }
}

struct JobResultDTO: Codable, Hashable {
    let imageUrl: String?
    let videoUrl: String?
    let audioUrl: String?
    let fileUrl: String?
    let text: String?
    let artifact: ArtifactDTO?
}

struct ArtifactDTO: Codable, Identifiable, Hashable {
    let id: String
    let name: String?
    let title: String?
    let type: String
    let mimeType: String?
    let size: Int
    let previewUrl: String
    let downloadUrl: String
    let createdAt: String?

    var displayName: String {
        let candidate = (name?.isEmpty == false ? name : title) ?? "未命名素材"
        return candidate
    }
}

struct GenerationRequest: Encodable {
    let nodeId: String
    let targetNodeId: String
    let kind: String
    let title: String
    let provider: String
    let model: String
    let prompt: String
    let inputs: [String]
    let references: [GenerationReference]
    let options: GenerationOptions
}

struct GenerationReference: Encodable, Identifiable, Hashable {
    let id: String
    let nodeId: String
    let title: String
    let kind: String
    let outputType: String
    let source: String
    let url: String?
}

struct GenerationOptions: Encodable {
    let providerTool: String
    let model: String
    let duration: Int?
    let aspectRatio: String?
    let resolution: String?
    let generateAudio: Bool?
    let shotCount: Int?
    let operation: String?
    let transition: String?
    let audioPolicy: String?
}

enum SampleData {
    static let canvases: [CanvasSummary] = [
        .init(id: "demo-rain-shop", name: "雨夜茶铺", nodeCount: 12, edgeCount: 15, updatedAt: "刚刚", active: true),
        .init(id: "demo-identity", name: "角色身份板", nodeCount: 23, edgeCount: 8, updatedAt: "昨天", active: false),
        .init(id: "demo-guard", name: "黑衣执令使", nodeCount: 8, edgeCount: 10, updatedAt: "7 月 18 日", active: false),
    ]

    static let nodes: [CanvasNodeDTO] = [
        .init(id: "demo-node-1", data: .init(kind: "text", title: "雨夜茶铺开场脚本", prompt: "雨声压低，木门轻响。", status: "success", progress: 100, error: nil)),
        .init(id: "demo-node-2", data: .init(kind: "image", title: "沈照雪 · 茶铺柜台", prompt: "半张脸被柔和灯光照亮", status: "success", progress: 100, error: nil)),
        .init(id: "demo-node-3", data: .init(kind: "video", title: "镜头推进 · 人物回头", prompt: "镜头缓慢推进，人物回头", status: "running", progress: 68, error: nil)),
        .init(id: "demo-node-4", data: .init(kind: "audio", title: "雨声与木门", prompt: "低频雨声，远处雷鸣", status: "idle", progress: 0, error: nil)),
    ]

    static let jobs: [GenerationJobDTO] = [
        .init(id: "demo-job-1", nodeId: "demo-node-3", targetNodeId: "demo-node-3", kind: "video", title: "雨夜茶铺 · 镜头 03", provider: "AnyCap", model: "seedance-2-fast", status: "running", progress: 68, prompt: "镜头缓慢推进，人物回头", error: nil, createdAt: "刚刚", updatedAt: "刚刚", result: nil),
        .init(id: "demo-job-2", nodeId: "demo-node-2", targetNodeId: "demo-node-2", kind: "image", title: "角色身份板", provider: "AnyCap", model: "nano-banana-2", status: "success", progress: 100, prompt: "角色身份板", error: nil, createdAt: "12:08", updatedAt: "12:09", result: .init(imageUrl: nil, videoUrl: nil, audioUrl: nil, fileUrl: nil, text: nil, artifact: nil)),
        .init(id: "demo-job-3", nodeId: "demo-node-4", targetNodeId: "demo-node-4", kind: "audio", title: "茶铺环境声", provider: "AnyCap", model: "doubao-seed-audio-1-0", status: "error", progress: 31, prompt: "雷雨环境声", error: "网络中断，任务未计费。", createdAt: "11:52", updatedAt: "11:53", result: nil),
    ]

    static let artifacts: [ArtifactDTO] = [
        .init(id: "demo-artifact-1", name: "沈照雪", title: nil, type: "image", mimeType: "image/png", size: 1_980_000, previewUrl: "", downloadUrl: "", createdAt: "今天"),
        .init(id: "demo-artifact-2", name: "雨夜茶铺", title: nil, type: "image", mimeType: "image/png", size: 2_130_000, previewUrl: "", downloadUrl: "", createdAt: "今天"),
        .init(id: "demo-artifact-3", name: "黑衣执令使", title: nil, type: "image", mimeType: "image/png", size: 1_810_000, previewUrl: "", downloadUrl: "", createdAt: "昨天"),
        .init(id: "demo-artifact-4", name: "柜台推进镜头", title: nil, type: "video", mimeType: "video/mp4", size: 12_400_000, previewUrl: "", downloadUrl: "", createdAt: "今天"),
        .init(id: "demo-artifact-5", name: "雷雨环境声", title: nil, type: "audio", mimeType: "audio/m4a", size: 3_100_000, previewUrl: "", downloadUrl: "", createdAt: "昨天"),
        .init(id: "demo-artifact-6", name: "青瓷茶盏", title: nil, type: "image", mimeType: "image/png", size: 920_000, previewUrl: "", downloadUrl: "", createdAt: "7 月 18 日"),
    ]
}
