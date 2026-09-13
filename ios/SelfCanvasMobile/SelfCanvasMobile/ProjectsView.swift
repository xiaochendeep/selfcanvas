import SwiftUI

struct ProjectsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var search = ""

    private var visibleCanvases: [CanvasSummary] {
        let source = appState.canvases.isEmpty && appState.isDemoMode ? SampleData.canvases : appState.canvases
        guard !search.isEmpty else { return source }
        return source.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        ZStack {
            SCTheme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    AppTopBar(title: "项目", subtitle: appState.connectionLabel)
                    HStack {
                        Image(systemName: "magnifyingglass").foregroundStyle(SCTheme.muted)
                        TextField("搜索项目", text: $search)
                    }
                    .padding(14)
                    .background(SCTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                    if visibleCanvases.isEmpty {
                        ContentUnavailableView("还没有项目", systemImage: "rectangle.3.group", description: Text("从创作页开始第一个项目。"))
                            .frame(maxWidth: .infinity)
                            .padding(.top, 80)
                    } else {
                        ForEach(visibleCanvases) { canvas in
                            NavigationLink {
                                ProjectDetailView(canvas: canvas)
                            } label: {
                                HStack(spacing: 14) {
                                    MediaPlaceholder(type: "image")
                                        .frame(width: 76, height: 76)
                                        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text(canvas.name).font(.headline).foregroundStyle(SCTheme.text)
                                            if canvas.active { StatusPill(text: "当前") }
                                        }
                                        Text("\(canvas.nodeCount) 个节点 · \(canvas.edgeCount) 条关系")
                                            .font(.caption).foregroundStyle(SCTheme.muted)
                                        Text(canvas.updatedAt.isEmpty ? "已同步" : canvas.updatedAt)
                                            .font(.caption2).foregroundStyle(SCTheme.muted)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(SCTheme.muted)
                                }
                                .scCard()
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 20)
            }
            .refreshable { await appState.refreshAll() }
        }
        .toolbar(.hidden, for: .navigationBar)
    }
}

struct ProjectDetailView: View {
    @EnvironmentObject private var appState: AppState
    let canvas: CanvasSummary
    @State private var filter = "全部"
    @State private var showNewNode = false

    private let filters = ["全部", "文本", "图片", "视频", "音频"]

    private var nodes: [CanvasNodeDTO] {
        let source = appState.canvasNodes[canvas.id] ?? []
        guard filter != "全部" else { return source }
        let kind: String = switch filter {
        case "文本": "text"
        case "图片": "image"
        case "视频": "video"
        case "音频": "audio"
        default: ""
        }
        return source.filter { $0.data.kind == kind }
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            SCTheme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(canvas.name).font(.largeTitle.weight(.bold))
                        Text("\(canvas.nodeCount) 个节点 · \(canvas.edgeCount) 条关系 · 已同步")
                            .font(.caption).foregroundStyle(SCTheme.muted)
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(filters, id: \.self) { item in
                                Button(item) { filter = item }
                                    .buttonStyle(.plain)
                                    .font(.subheadline.weight(.medium))
                                    .padding(.horizontal, 13)
                                    .frame(height: 40)
                                    .foregroundStyle(filter == item ? .white : SCTheme.muted)
                                    .background(filter == item ? SCTheme.purple : SCTheme.surfaceRaised)
                                    .clipShape(Capsule())
                            }
                        }
                    }

                    if nodes.isEmpty {
                        ProgressView("加载镜头…")
                            .frame(maxWidth: .infinity)
                            .padding(.top, 80)
                    } else {
                        VStack(spacing: 12) {
                            ForEach(Array(nodes.enumerated()), id: \.element.id) { index, node in
                                NavigationLink {
                                    NodeDetailView(node: node)
                                } label: {
                                    NodeCard(index: index + 1, node: node)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 88)
            }

            Button {
                showNewNode = true
            } label: {
                Image(systemName: "plus")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 58, height: 58)
                    .background(SCTheme.purple)
                    .clipShape(Circle())
                    .shadow(color: SCTheme.purple.opacity(0.35), radius: 16, y: 8)
            }
            .padding(20)
        }
        .navigationTitle("镜头流")
        .navigationBarTitleDisplayMode(.inline)
        .task { await appState.loadCanvas(canvas) }
        .sheet(isPresented: $showNewNode) {
            GenerationComposerView(mode: .video, prompt: "", initialReferences: [])
        }
    }
}

struct NodeCard: View {
    let index: Int
    let node: CanvasNodeDTO

    private var statusColor: Color {
        switch node.data.status {
        case "success": SCTheme.success
        case "running": SCTheme.warning
        case "error": SCTheme.danger
        default: SCTheme.muted
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(String(format: "%02d", index))
                .font(.caption.monospacedDigit())
                .foregroundStyle(SCTheme.muted)
                .frame(width: 28, alignment: .leading)
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(SCTheme.surfaceRaised)
                    .frame(width: 54, height: 54)
                Image(systemName: symbol(for: node.data.kind))
                    .foregroundStyle(SCTheme.purple)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(node.data.title).font(.headline).foregroundStyle(SCTheme.text)
                if let prompt = node.data.prompt, !prompt.isEmpty {
                    Text(prompt).font(.caption).foregroundStyle(SCTheme.muted).lineLimit(2)
                }
                HStack(spacing: 6) {
                    Circle().fill(statusColor).frame(width: 7, height: 7)
                    Text(statusText).font(.caption2).foregroundStyle(SCTheme.muted)
                }
            }
            Spacer()
            Image(systemName: "line.3.horizontal").foregroundStyle(SCTheme.muted)
        }
        .scCard()
    }

    private var statusText: String {
        switch node.data.status {
        case "success": "已完成"
        case "running": "生成中 \(Int(node.data.progress ?? 0))%"
        case "error": node.data.error ?? "失败"
        default: "待处理"
        }
    }

    private func symbol(for kind: String) -> String {
        switch kind {
        case "video": "video"
        case "audio": "waveform"
        case "text", "storyboard": "text.alignleft"
        default: "photo"
        }
    }
}

struct NodeDetailView: View {
    let node: CanvasNodeDTO

    var body: some View {
        ZStack {
            SCTheme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    MediaPlaceholder(type: node.data.kind, title: node.data.title)
                        .frame(height: 300)
                        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    Text(node.data.title).font(.title2.weight(.semibold))
                    if let prompt = node.data.prompt {
                        Text(prompt).foregroundStyle(SCTheme.muted).scCard()
                    }
                    Button("继续编辑") {}
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .foregroundStyle(.white)
                        .background(SCTheme.purple)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .padding(16)
            }
        }
        .navigationTitle("节点详情")
        .navigationBarTitleDisplayMode(.inline)
    }
}
