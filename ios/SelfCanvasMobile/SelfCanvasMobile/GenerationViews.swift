import AVKit
import SwiftUI

struct GenerationComposerView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let mode: GenerationMode
    @State private var prompt: String
    @State private var references: [ArtifactDTO]
    @State private var aspectRatio = "9:16"
    @State private var resolution = "720p"
    @State private var duration = 5
    @State private var generateAudio = true
    @State private var videoOperation: VideoOperation = .generate
    @State private var transition = "cut"
    @State private var audioPolicy = "keep"
    @State private var showSettings = false
    @State private var showAssets = false
    @State private var submitting = false
    @State private var errorMessage: String?

    init(mode: GenerationMode, prompt: String, initialReferences: [ArtifactDTO]) {
        self.mode = mode
        _prompt = State(initialValue: prompt)
        _references = State(initialValue: initialReferences)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                SCTheme.background.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 17) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(mode.rawValue).font(.largeTitle.weight(.bold))
                            Text("先确认画面、参考和输出设置")
                                .foregroundStyle(SCTheme.muted)
                        }

                        if mode == .video {
                            videoOperationPicker
                        }

                        MediaPlaceholder(type: mode.kind, title: "结果会显示在这里")
                            .frame(height: mode == .audio ? 170 : 250)
                            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                            .overlay(alignment: .topTrailing) {
                                StatusPill(text: "预览", color: SCTheme.muted).padding(12)
                            }

                        HStack {
                            Text("参考素材").font(.headline)
                            Spacer()
                            Button {
                                showAssets = true
                            } label: { Label("添加", systemImage: "plus") }
                                .font(.subheadline)
                        }
                        if references.isEmpty {
                            Button {
                                showAssets = true
                            } label: {
                                Label("加入图片、视频或音频参考", systemImage: "paperclip")
                                    .frame(maxWidth: .infinity, minHeight: 48)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(SCTheme.muted)
                            .background(SCTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        } else {
                            ReferenceStrip(references: references)
                        }
                        if let range = videoOperation.referenceRange, mode == .video {
                            Label("需要 \(range.lowerBound)–\(range.upperBound) 段已落盘视频，当前 \(videoReferenceCount) 段", systemImage: "film.stack")
                                .font(.caption)
                                .foregroundStyle(referenceCountValid ? SCTheme.success : SCTheme.warning)
                        }

                        Text("提示词").font(.headline)
                        TextEditor(text: $prompt)
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 150)
                            .padding(10)
                            .background(SCTheme.surface)
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .overlay(alignment: .bottomTrailing) {
                                Image(systemName: "arrow.up.left.and.arrow.down.right")
                                    .foregroundStyle(SCTheme.muted)
                                    .padding(12)
                                    .allowsHitTesting(false)
                            }

                        HStack(spacing: 8) {
                            SettingsChip(text: displayModel, symbol: "cpu")
                            if mode == .video || mode == .image {
                                SettingsChip(text: "\(aspectRatio) · \(resolution)", symbol: "slider.horizontal.3")
                                    .onTapGesture { showSettings = true }
                            }
                            if mode == .video {
                                SettingsChip(text: "\(duration) 秒", symbol: "timer")
                                    .onTapGesture { showSettings = true }
                            }
                        }

                        if let errorMessage {
                            Label(errorMessage, systemImage: "exclamationmark.circle.fill")
                                .font(.footnote).foregroundStyle(SCTheme.danger)
                        }

                        Button {
                            generate()
                        } label: {
                            HStack {
                                if submitting { ProgressView().tint(.white) }
                                else { Image(systemName: "paperplane.fill") }
                                Text(submitting ? "提交中…" : "开始生成").fontWeight(.semibold)
                            }
                            .frame(maxWidth: .infinity, minHeight: 52)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.white)
                        .background(canSubmit ? SCTheme.purple : SCTheme.muted)
                        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                        .disabled(!canSubmit || submitting)
                    }
                    .padding(16)
                    .padding(.bottom, 20)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    if mode == .video {
                        Button {
                            generateAudio.toggle()
                        } label: {
                            Image(systemName: generateAudio ? "speaker.wave.2.fill" : "speaker.slash.fill")
                        }
                        .accessibilityLabel(generateAudio ? "包含声音" : "不包含声音")
                    }
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            OutputSettingsSheet(
                aspectRatio: $aspectRatio,
                resolution: $resolution,
                duration: $duration,
                generateAudio: $generateAudio,
                transition: $transition,
                audioPolicy: $audioPolicy,
                showsVideoSettings: mode == .video,
                videoOperation: mode == .video ? videoOperation : .generate
            )
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAssets) {
            AssetPickerSheet(
                selected: $references,
                allowedTypes: mode == .video && videoOperation != .generate ? ["video"] : nil
            )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private func generate() {
        submitting = true
        errorMessage = nil
        Task {
            do {
                try await appState.submitGeneration(
                    mode: mode,
                    prompt: prompt,
                    references: references,
                    aspectRatio: aspectRatio,
                    resolution: resolution,
                    duration: duration,
                    generateAudio: generateAudio,
                    videoOperation: videoOperation,
                    transition: transition,
                    audioPolicy: audioPolicy
                )
                submitting = false
                dismiss()
            } catch {
                submitting = false
                errorMessage = error.localizedDescription
            }
        }
    }

    private var videoReferenceCount: Int { references.filter { $0.type == "video" }.count }

    private var referenceCountValid: Bool {
        guard mode == .video, let range = videoOperation.referenceRange else { return true }
        return range.contains(videoReferenceCount) && videoReferenceCount == references.count
    }

    private var canSubmit: Bool {
        let hasPrompt = !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if mode == .video && videoOperation == .concat { return referenceCountValid }
        return hasPrompt && referenceCountValid
    }

    private var displayModel: String {
        guard mode == .video else { return appState.model(for: mode) }
        return switch videoOperation {
        case .generate: appState.model(for: mode)
        case .aiEdit, .concat: "SelfCanvas Edit"
        case .creativeEdit: "AnyCap Creative"
        }
    }

    private var videoOperationPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(VideoOperation.allCases) { operation in
                    let unavailable = operation != .generate && appState.capabilities?.features.videoEditing == false
                    Button {
                        videoOperation = operation
                        if operation != .generate {
                            references = references.filter { $0.type == "video" }
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(operation.title).font(.subheadline.weight(.semibold))
                            Text(operation.subtitle).font(.caption2).lineLimit(1)
                        }
                        .foregroundStyle(videoOperation == operation ? .white : SCTheme.muted)
                        .padding(.horizontal, 14)
                        .frame(width: 168, height: 64, alignment: .leading)
                        .background(videoOperation == operation ? SCTheme.purple : SCTheme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .opacity(unavailable ? 0.45 : 1)
                    .disabled(unavailable)
                }
            }
        }
    }
}

struct SettingsChip: View {
    let text: String
    let symbol: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
            Text(text).lineLimit(1)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(SCTheme.text)
        .padding(.horizontal, 10)
        .frame(minHeight: 40)
        .background(SCTheme.surfaceRaised)
        .clipShape(Capsule())
    }
}

struct OutputSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var aspectRatio: String
    @Binding var resolution: String
    @Binding var duration: Int
    @Binding var generateAudio: Bool
    @Binding var transition: String
    @Binding var audioPolicy: String
    let showsVideoSettings: Bool
    let videoOperation: VideoOperation

    var body: some View {
        NavigationStack {
            Form {
                Picker("画面比例", selection: $aspectRatio) {
                    ForEach(["9:16", "16:9", "1:1", "3:4"], id: \.self) { Text($0) }
                }
                Picker("分辨率", selection: $resolution) {
                    ForEach(["720p", "1080p"], id: \.self) { Text($0) }
                }
                if showsVideoSettings {
                    Picker("时长", selection: $duration) {
                        ForEach([5, 8, 10], id: \.self) { Text("\($0) 秒") }
                    }
                    Toggle("生成声音", isOn: $generateAudio)
                    if videoOperation != .generate {
                        Picker("转场", selection: $transition) {
                            Text("硬切").tag("cut")
                            Text("交叉淡化").tag("crossfade")
                        }
                        Picker("声音策略", selection: $audioPolicy) {
                            Text("保留原声").tag("keep")
                            Text("静音").tag("mute")
                            Text("音量标准化").tag("normalize")
                        }
                    }
                }
            }
            .navigationTitle("输出设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}

struct TaskResultView: View {
    @EnvironmentObject private var appState: AppState
    let job: GenerationJobDTO

    private var resultType: String { job.kind }
    private var resultPath: String? {
        job.result?.artifact?.previewUrl ?? job.result?.videoUrl ?? job.result?.imageUrl ?? job.result?.audioUrl ?? job.result?.fileUrl
    }

    var body: some View {
        ZStack {
            SCTheme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Group {
                        if job.kind == "image", let url = appState.assetURL(resultPath) {
                            AsyncImage(url: url) { phase in
                                if let image = phase.image { image.resizable().scaledToFit() }
                                else { MediaPlaceholder(type: resultType, title: job.displayTitle) }
                            }
                        } else if job.kind == "video", let url = appState.assetURL(resultPath) {
                            RemoteVideoResultView(url: url)
                        } else if job.kind == "audio", let url = appState.assetURL(resultPath) {
                            RemoteAudioResultView(url: url, title: job.displayTitle)
                        } else {
                            MediaPlaceholder(type: resultType, title: job.displayTitle)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 430)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))

                    VStack(alignment: .leading, spacing: 6) {
                        Text(job.displayTitle).font(.title2.weight(.semibold))
                        Text("\(job.provider) · \(job.model)").foregroundStyle(SCTheme.muted)
                    }

                    HStack(spacing: 10) {
                        if let url = appState.assetURL(job.result?.artifact?.downloadUrl ?? resultPath) {
                            ShareLink(item: url) {
                                Label("下载与分享", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity, minHeight: 50)
                            }
                            .foregroundStyle(.white)
                            .background(SCTheme.purple)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        } else {
                            Button("结果尚未落盘") {}
                                .frame(maxWidth: .infinity, minHeight: 50)
                                .foregroundStyle(SCTheme.muted)
                                .background(SCTheme.surfaceRaised)
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .disabled(true)
                        }
                    }

                    Text(job.prompt).foregroundStyle(SCTheme.muted).scCard()
                }
                .padding(16)
            }
        }
        .navigationTitle(job.status == "success" ? "生成结果" : "任务详情")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct RemoteVideoResultView: View {
    @State private var player: AVPlayer

    init(url: URL) {
        _player = State(initialValue: AVPlayer(url: url))
    }

    var body: some View {
        VideoPlayer(player: player)
            .background(Color.black)
            .onDisappear { player.pause() }
            .accessibilityLabel("视频结果播放器")
    }
}

private struct RemoteAudioResultView: View {
    @State private var player: AVPlayer
    @State private var isPlaying = false
    let title: String

    init(url: URL, title: String) {
        _player = State(initialValue: AVPlayer(url: url))
        self.title = title
    }

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "waveform.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(SCTheme.purple)
            Text(title).font(.headline).multilineTextAlignment(.center)
            Button {
                if isPlaying { player.pause() } else { player.play() }
                isPlaying.toggle()
            } label: {
                Label(isPlaying ? "暂停" : "播放", systemImage: isPlaying ? "pause.fill" : "play.fill")
                    .frame(minWidth: 120, minHeight: 48)
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SCTheme.surfaceRaised)
        .onDisappear { player.pause() }
    }
}
