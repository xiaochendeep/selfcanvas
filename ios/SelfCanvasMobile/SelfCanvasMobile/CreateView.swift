import SwiftUI

struct CreateView: View {
    @EnvironmentObject private var appState: AppState
    @State private var mode: GenerationMode = .director
    @State private var prompt = "做一段雨夜茶铺的悬疑短片，人物回头时灯光轻微闪烁。"
    @State private var showComposer = false
    @State private var showAssetPicker = false
    @State private var references: [ArtifactDTO] = []

    var body: some View {
        ZStack {
            SCTheme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    AppTopBar(title: "开始创作", subtitle: greeting)

                    sectionHeader("最近项目", action: "查看全部") {
                        appState.selectedTab = .projects
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(appState.canvases.isEmpty ? SampleData.canvases : appState.canvases.prefix(4).map { $0 }) { canvas in
                                Button {
                                    appState.selectedTab = .projects
                                } label: {
                                    VStack(alignment: .leading, spacing: 10) {
                                        MediaPlaceholder(type: "video")
                                            .frame(width: 170, height: 92)
                                            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                                        Text(canvas.name).font(.headline).foregroundStyle(SCTheme.text)
                                        Text("\(canvas.nodeCount) 个节点")
                                            .font(.caption).foregroundStyle(SCTheme.muted)
                                    }
                                    .frame(width: 170, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Text("告诉 AI 你想做什么").font(.headline)
                            Spacer()
                            StatusPill(text: "智能编排")
                        }

                        TextEditor(text: $prompt)
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 118)
                            .padding(10)
                            .background(SCTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(GenerationMode.allCases) { item in
                                    Button {
                                        mode = item
                                    } label: {
                                        Label(item.rawValue, systemImage: item.symbol)
                                            .font(.subheadline.weight(.medium))
                                            .padding(.horizontal, 12)
                                            .frame(minHeight: 40)
                                    }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(mode == item ? .white : SCTheme.muted)
                                    .background(mode == item ? SCTheme.purple : SCTheme.surfaceRaised)
                                    .clipShape(Capsule())
                                }
                            }
                        }

                        if !references.isEmpty {
                            ReferenceStrip(references: references)
                        }

                        HStack(spacing: 10) {
                            Button {
                                showAssetPicker = true
                            } label: {
                                Label("素材", systemImage: "paperclip")
                                    .frame(minWidth: 82, minHeight: 48)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(SCTheme.text)
                            .background(SCTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                            Button {
                                showComposer = true
                            } label: {
                                HStack {
                                    Text("继续").fontWeight(.semibold)
                                    Spacer()
                                    Image(systemName: "arrow.up.right")
                                }
                                .padding(.horizontal, 18)
                                .frame(maxWidth: .infinity, minHeight: 48)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.white)
                            .background(SCTheme.purple)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                    }
                    .scCard()

                    Text("快捷开始").font(.headline)
                    LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 12) {
                        ForEach(GenerationMode.allCases) { item in
                            Button {
                                mode = item
                                showComposer = true
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: item.symbol)
                                        .foregroundStyle(SCTheme.purple)
                                    Text(item == .director ? "AI 拆分镜" : "生成\(item.rawValue)")
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(SCTheme.text)
                                    Spacer()
                                }
                                .frame(minHeight: 48)
                            }
                            .buttonStyle(.plain)
                            .scCard()
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 20)
            }
            .refreshable { await appState.refreshAll() }
        }
        .sheet(isPresented: $showComposer) {
            GenerationComposerView(mode: mode, prompt: prompt, initialReferences: references)
        }
        .sheet(isPresented: $showAssetPicker) {
            AssetPickerSheet(selected: $references)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        return hour < 12 ? "早上好，\(appState.username)" : hour < 18 ? "下午好，\(appState.username)" : "晚上好，\(appState.username)"
    }

    private func sectionHeader(_ title: String, action: String, handler: @escaping () -> Void) -> some View {
        HStack {
            Text(title).font(.headline)
            Spacer()
            Button(action, action: handler).font(.subheadline).foregroundStyle(SCTheme.muted)
        }
    }
}

struct ReferenceStrip: View {
    let references: [ArtifactDTO]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(references) { item in
                    HStack(spacing: 8) {
                        Image(systemName: item.type == "video" ? "video" : item.type == "audio" ? "waveform" : "photo")
                            .foregroundStyle(SCTheme.purple)
                        Text(item.displayName).font(.caption).lineLimit(1)
                    }
                    .padding(.horizontal, 11)
                    .frame(height: 38)
                    .background(SCTheme.surfaceRaised)
                    .clipShape(Capsule())
                }
            }
        }
    }
}
