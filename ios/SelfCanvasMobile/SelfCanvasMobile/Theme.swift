import SwiftUI

enum SCTheme {
    static let background = Color(hex: 0x06070A)
    static let surface = Color(hex: 0x12141C)
    static let surfaceRaised = Color(hex: 0x1A1D28)
    static let purple = Color(hex: 0x8173FF)
    static let blue = Color(hex: 0x4F7BFF)
    static let text = Color(hex: 0xF6F7FB)
    static let muted = Color(hex: 0x989DAC)
    static let success = Color(hex: 0x70E1C8)
    static let warning = Color(hex: 0xF3BF6A)
    static let danger = Color(hex: 0xFF6B74)
}

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

struct SCCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .background(SCTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(Color.white.opacity(0.07), lineWidth: 1)
            }
    }
}

extension View {
    func scCard() -> some View { modifier(SCCardModifier()) }
}

struct StatusPill: View {
    let text: String
    var color: Color = SCTheme.purple

    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color.opacity(0.13))
            .clipShape(Capsule())
    }
}

struct AppTopBar: View {
    @EnvironmentObject private var appState: AppState
    let title: String
    var subtitle: String? = nil
    @State private var showAccount = false

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.title2.weight(.semibold))
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(SCTheme.muted)
                }
            }
            Spacer()
            Button {
                showAccount = true
            } label: {
                Image(systemName: "person.crop.circle.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(SCTheme.purple)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("账号设置")
        }
        .sheet(isPresented: $showAccount) {
            AccountSheet()
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }
}

struct AccountSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("账号") {
                    LabeledContent("当前用户", value: appState.username)
                    LabeledContent("服务器", value: appState.connectionLabel)
                }
                Section("内测设置") {
                    LabeledContent("媒体生成", value: appState.capabilities?.features.mediaGeneration == false ? "不可用" : "可用")
                    LabeledContent("AI 视频剪辑", value: appState.capabilities?.features.videoEditing == true ? "已连接" : "未连接")
                    LabeledContent("Codex MCP", value: appState.capabilities?.features.codexMcp == true ? "已启用" : "未启用")
                    Label("Face ID", systemImage: "faceid")
                    Label("任务完成通知", systemImage: "bell.badge")
                    Label("导出诊断日志", systemImage: "doc.text")
                }
                Section {
                    Button("退出登录", role: .destructive) {
                        dismiss()
                        appState.signOut()
                    }
                }
            }
            .navigationTitle("账号与设置")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct MediaPlaceholder: View {
    let type: String
    var title: String? = nil

    private var symbol: String {
        switch type {
        case "video": "video.fill"
        case "audio": "waveform"
        case "text", "storyboard": "text.alignleft"
        default: "photo.fill"
        }
    }

    var body: some View {
        ZStack {
            SCTheme.surfaceRaised
            Circle()
                .fill(SCTheme.purple.opacity(0.22))
                .frame(width: 100, height: 100)
                .blur(radius: 16)
            VStack(spacing: 8) {
                Image(systemName: symbol)
                    .font(.title2)
                    .foregroundStyle(SCTheme.muted)
                if let title {
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(SCTheme.muted)
                        .lineLimit(1)
                }
            }
        }
    }
}

struct RemoteMediaPreview: View {
    @EnvironmentObject private var appState: AppState
    let artifact: ArtifactDTO

    var body: some View {
        if artifact.type == "image", let url = appState.assetURL(artifact.previewUrl) {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    MediaPlaceholder(type: artifact.type, title: artifact.displayName)
                }
            }
        } else {
            MediaPlaceholder(type: artifact.type, title: artifact.displayName)
        }
    }
}
