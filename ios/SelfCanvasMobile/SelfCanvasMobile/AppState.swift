import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var isAuthenticated = false
    @Published var isDemoMode = false
    @Published var isBusy = false
    @Published var selectedTab: AppTab = .create
    @Published var username = ""
    @Published var connectionLabel = "未连接"
    @Published var errorMessage: String?
    @Published var canvases: [CanvasSummary] = []
    @Published var jobs: [GenerationJobDTO] = []
    @Published var artifacts: [ArtifactDTO] = []
    @Published var canvasNodes: [String: [CanvasNodeDTO]] = [:]
    @Published var capabilities: MobileCapabilitiesDTO?

    private let keychain = KeychainStore()
    private var credential: SessionCredential?

    init() {
        if let credential = keychain.load() {
            self.credential = credential
            username = credential.username
            isAuthenticated = true
            connectionLabel = "正在恢复连接"
            Task { await refreshAll() }
        }
    }

    var apiClient: APIClient? {
        guard let credential else { return nil }
        return try? APIClient(serverURL: credential.serverURL, token: credential.accessToken)
    }

    func signIn(serverURL: String, username: String, password: String) async {
        let cleanUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanPassword = password.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanUsername.isEmpty, !cleanPassword.isEmpty else {
            errorMessage = "请输入账号和密码"
            return
        }

        isBusy = true
        errorMessage = nil
        defer { isBusy = false }

        do {
            let session = try await APIClient.login(serverURL: serverURL, username: cleanUsername, password: cleanPassword)
            let next = SessionCredential(
                serverURL: serverURL,
                username: session.user.username,
                accessToken: session.accessToken,
                refreshToken: session.refreshToken,
                expiresAt: session.expiresAt
            )
            try keychain.save(next)
            credential = next
            self.username = session.user.username
            isDemoMode = false
            isAuthenticated = true
            connectionLabel = "已连接"
            await refreshAll()
        } catch {
            errorMessage = error.localizedDescription
            connectionLabel = "连接失败"
        }
    }

    func enterDemo() {
        keychain.remove()
        credential = nil
        username = "内部体验账号"
        isDemoMode = true
        isAuthenticated = true
        connectionLabel = "离线演示"
        canvases = SampleData.canvases
        jobs = SampleData.jobs
        artifacts = SampleData.artifacts
        canvasNodes[SampleData.canvases[0].id] = SampleData.nodes
    }

    func signOut() {
        let client = apiClient
        let refreshToken = credential?.refreshToken
        if let client, let refreshToken {
            Task { try? await client.logout(refreshToken: refreshToken) }
        }
        keychain.remove()
        credential = nil
        isAuthenticated = false
        isDemoMode = false
        selectedTab = .create
        connectionLabel = "未连接"
        errorMessage = nil
        canvases = []
        jobs = []
        artifacts = []
        canvasNodes = [:]
        capabilities = nil
    }

    func refreshAll() async {
        guard !isDemoMode, apiClient != nil else {
            if isDemoMode {
                canvases = SampleData.canvases
                jobs = SampleData.jobs
                artifacts = SampleData.artifacts
            }
            return
        }

        do {
            canvases = try await authorized { try await $0.fetchCanvases().canvases }
            connectionLabel = "已同步"
        } catch {
            errorMessage = error.localizedDescription
            connectionLabel = "离线"
        }

        do {
            capabilities = try await authorized { try await $0.fetchCapabilities() }
        } catch {
            capabilities = nil
        }

        await refreshJobs()

        do {
            artifacts = try await authorized { try await $0.fetchArtifacts() }
        } catch {
            if artifacts.isEmpty { artifacts = [] }
        }
    }

    func loadCanvas(_ canvas: CanvasSummary) async {
        if isDemoMode || canvas.id.hasPrefix("demo-") {
            canvasNodes[canvas.id] = SampleData.nodes
            return
        }
        guard apiClient != nil else { return }
        do {
            canvasNodes[canvas.id] = try await authorized { try await $0.fetchCanvas(id: canvas.id).nodes }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshJobs() async {
        if isDemoMode {
            jobs = SampleData.jobs
            return
        }
        guard apiClient != nil else { return }
        do {
            jobs = try await authorized { try await $0.fetchJobs() }
        } catch {
            if jobs.isEmpty { jobs = [] }
        }
    }

    func submitGeneration(
        mode: GenerationMode,
        prompt: String,
        references: [ArtifactDTO],
        aspectRatio: String,
        resolution: String,
        duration: Int,
        generateAudio: Bool,
        videoOperation: VideoOperation = .generate,
        transition: String = "cut",
        audioPolicy: String = "keep"
    ) async throws {
        if isDemoMode {
            let job = GenerationJobDTO(
                id: "demo-\(UUID().uuidString)", nodeId: nil, targetNodeId: nil,
                kind: mode.kind, title: "\(mode.rawValue) · 新任务", provider: "SelfCanvas",
                model: mode.model, status: "queued", progress: 0, prompt: prompt,
                error: nil, createdAt: "刚刚", updatedAt: "刚刚", result: nil
            )
            jobs.insert(job, at: 0)
            selectedTab = .tasks
            return
        }

        guard apiClient != nil else { throw APIClientError.unauthorized }
        let providerTool = mode == .director ? "sub2api" : "anycap"
        let defaultModel = model(for: mode)
        let requestedModel: String = if mode == .video {
            switch videoOperation {
            case .aiEdit, .concat: "selfcanvas-smart-edit"
            case .creativeEdit: capabilities?.models.creativeVideo ?? "gemini-omni-flash-preview"
            case .generate: defaultModel
            }
        } else {
            defaultModel
        }
        let request = GenerationRequest(
            nodeId: "mobile-\(UUID().uuidString)",
            targetNodeId: "",
            kind: mode.kind,
            title: "\(mode.rawValue) · 手机端",
            provider: mode == .director ? "Sub2API" : "AnyCap",
            model: requestedModel,
            prompt: prompt,
            inputs: [],
            references: references.map {
                GenerationReference(
                    id: $0.id, nodeId: $0.id, title: $0.displayName,
                    kind: $0.type, outputType: $0.type, source: "output", url: $0.previewUrl
                )
            },
            options: GenerationOptions(
                providerTool: providerTool, model: requestedModel,
                duration: mode == .video ? duration : nil,
                aspectRatio: mode == .image || mode == .video ? aspectRatio : nil,
                resolution: mode == .video ? resolution : nil,
                generateAudio: mode == .video ? generateAudio : nil,
                shotCount: mode == .director ? 5 : nil,
                operation: mode == .video ? videoOperation.rawValue : nil,
                transition: mode == .video && videoOperation != .generate ? transition : nil,
                audioPolicy: mode == .video && videoOperation != .generate ? audioPolicy : nil
            )
        )
        let job = try await authorized { try await $0.createJob(request) }
        jobs.insert(job, at: 0)
        selectedTab = .tasks
    }

    func cancelJob(_ job: GenerationJobDTO) async {
        guard !isDemoMode, apiClient != nil else {
            jobs.removeAll { $0.id == job.id }
            return
        }
        do {
            _ = try await authorized { try await $0.cancelJob(id: job.id) }
            await refreshAll()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func assetURL(_ path: String?) -> URL? {
        apiClient?.absoluteURL(for: path)
    }

    func model(for mode: GenerationMode) -> String {
        guard let models = capabilities?.models else { return mode.model }
        return switch mode {
        case .director: models.director
        case .image: models.image
        case .video: models.video
        case .audio: models.audio
        }
    }

    private func authorized<Value>(_ action: (APIClient) async throws -> Value) async throws -> Value {
        guard let client = apiClient else { throw APIClientError.unauthorized }
        do {
            return try await action(client)
        } catch APIClientError.unauthorized {
            try await refreshCredential()
            guard let refreshed = apiClient else { throw APIClientError.unauthorized }
            return try await action(refreshed)
        }
    }

    private func refreshCredential() async throws {
        guard let current = credential else { throw APIClientError.unauthorized }
        do {
            let client = try APIClient(serverURL: current.serverURL)
            let session = try await client.refresh(refreshToken: current.refreshToken)
            let next = SessionCredential(
                serverURL: current.serverURL,
                username: session.user.username,
                accessToken: session.accessToken,
                refreshToken: session.refreshToken,
                expiresAt: session.expiresAt
            )
            try keychain.save(next)
            credential = next
            username = session.user.username
        } catch {
            keychain.remove()
            credential = nil
            isAuthenticated = false
            connectionLabel = "登录已过期"
            throw error
        }
    }
}
