import SwiftUI

struct AssetsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var search = ""
    @State private var filter = "全部"
    @State private var selected = Set<String>()

    private let filters = ["全部", "图片", "视频", "音频"]
    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    private var visibleArtifacts: [ArtifactDTO] {
        let source = appState.artifacts.isEmpty && appState.isDemoMode ? SampleData.artifacts : appState.artifacts
        return source.filter { artifact in
            let typeMatches = filter == "全部" ||
                (filter == "图片" && artifact.type == "image") ||
                (filter == "视频" && artifact.type == "video") ||
                (filter == "音频" && artifact.type == "audio")
            let searchMatches = search.isEmpty || artifact.displayName.localizedCaseInsensitiveContains(search)
            return typeMatches && searchMatches
        }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            SCTheme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    AppTopBar(title: "资产", subtitle: "\(appState.artifacts.count) 个服务器素材")
                    HStack {
                        Image(systemName: "magnifyingglass").foregroundStyle(SCTheme.muted)
                        TextField("搜索人物、场景或文件名", text: $search)
                    }
                    .padding(14)
                    .background(SCTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

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

                    if visibleArtifacts.isEmpty {
                        ContentUnavailableView("没有找到素材", systemImage: "folder", description: Text("新生成或导入的素材会显示在这里。"))
                            .frame(maxWidth: .infinity)
                            .padding(.top, 80)
                    } else {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(visibleArtifacts) { artifact in
                                Button {
                                    if selected.contains(artifact.id) { selected.remove(artifact.id) }
                                    else { selected.insert(artifact.id) }
                                } label: {
                                    VStack(alignment: .leading, spacing: 8) {
                                        RemoteMediaPreview(artifact: artifact)
                                            .frame(height: 142)
                                            .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                                            .overlay(alignment: .topTrailing) {
                                                if selected.contains(artifact.id) {
                                                    Image(systemName: "checkmark.circle.fill")
                                                        .font(.title2)
                                                        .foregroundStyle(.white, SCTheme.purple)
                                                        .padding(8)
                                                }
                                            }
                                        Text(artifact.displayName).font(.subheadline.weight(.medium)).lineLimit(1)
                                        Text("\(typeLabel(artifact.type)) · \(formattedSize(artifact.size))")
                                            .font(.caption2).foregroundStyle(SCTheme.muted)
                                    }
                                    .foregroundStyle(SCTheme.text)
                                    .padding(10)
                                    .background(selected.contains(artifact.id) ? SCTheme.purple.opacity(0.12) : SCTheme.surface)
                                    .clipShape(RoundedRectangle(cornerRadius: 21, style: .continuous))
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 21, style: .continuous)
                                            .stroke(selected.contains(artifact.id) ? SCTheme.purple : Color.white.opacity(0.06), lineWidth: 1)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, selected.isEmpty ? 20 : 94)
            }
            .refreshable { await appState.refreshAll() }

            if !selected.isEmpty {
                HStack(spacing: 10) {
                    Button {
                        selected.removeAll()
                    } label: {
                        Image(systemName: "xmark").frame(width: 46, height: 46)
                    }
                    .buttonStyle(.plain)
                    .background(SCTheme.surfaceRaised)
                    .clipShape(Circle())

                    Button {
                        appState.selectedTab = .create
                    } label: {
                        Label("插入到创作 · \(selected.count)", systemImage: "plus")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                    .background(SCTheme.purple)
                    .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                }
                .padding(12)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                .padding(16)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    private func typeLabel(_ type: String) -> String {
        switch type { case "video": "视频"; case "audio": "音频"; default: "图片" }
    }

    private func formattedSize(_ size: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }
}

struct AssetPickerSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @Binding var selected: [ArtifactDTO]
    var allowedTypes: Set<String>? = nil
    @State private var working = Set<String>()
    @State private var search = ""

    private var source: [ArtifactDTO] {
        let all = appState.artifacts.isEmpty && appState.isDemoMode ? SampleData.artifacts : appState.artifacts
        return all.filter { artifact in
            let typeMatches = allowedTypes?.contains(artifact.type) ?? true
            let searchMatches = search.isEmpty || artifact.displayName.localizedCaseInsensitiveContains(search)
            return typeMatches && searchMatches
        }
    }

    var body: some View {
        NavigationStack {
            List(source) { artifact in
                Button {
                    if working.contains(artifact.id) { working.remove(artifact.id) }
                    else { working.insert(artifact.id) }
                } label: {
                    HStack(spacing: 12) {
                        RemoteMediaPreview(artifact: artifact)
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(artifact.displayName).foregroundStyle(SCTheme.text)
                            Text(artifact.type).font(.caption).foregroundStyle(SCTheme.muted)
                        }
                        Spacer()
                        Image(systemName: working.contains(artifact.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(working.contains(artifact.id) ? SCTheme.purple : SCTheme.muted)
                    }
                }
                .buttonStyle(.plain)
            }
            .searchable(text: $search, prompt: "搜索素材")
            .navigationTitle("选择参考素材")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("加入 \(working.count)") {
                        let chosen = source.filter { working.contains($0.id) }
                        var merged = Dictionary(uniqueKeysWithValues: selected.map { ($0.id, $0) })
                        chosen.forEach { merged[$0.id] = $0 }
                        selected = Array(merged.values)
                        dismiss()
                    }
                    .disabled(working.isEmpty)
                }
            }
            .onAppear { working = Set(selected.map(\.id)) }
        }
    }
}
