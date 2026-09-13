import SwiftUI

struct TasksView: View {
    @EnvironmentObject private var appState: AppState
    @State private var filter = "进行中"
    private let filters = ["进行中", "已完成", "失败"]

    private var jobs: [GenerationJobDTO] {
        appState.jobs.filter { job in
            switch filter {
            case "已完成": job.status == "success"
            case "失败": job.status == "error" || job.status == "canceled"
            default: !job.isFinished
            }
        }
    }

    var body: some View {
        ZStack {
            SCTheme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    AppTopBar(title: "任务", subtitle: "离开 App 后继续运行")

                    Picker("任务状态", selection: $filter) {
                        ForEach(filters, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    if jobs.isEmpty {
                        ContentUnavailableView("暂无\(filter)任务", systemImage: "checklist", description: Text("生成任务会自动出现在这里。"))
                            .frame(maxWidth: .infinity)
                            .padding(.top, 100)
                    } else {
                        ForEach(jobs) { job in
                            NavigationLink {
                                TaskResultView(job: job)
                            } label: {
                                JobCard(job: job)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                if !job.isFinished {
                                    Button("取消任务", role: .destructive) {
                                        Task { await appState.cancelJob(job) }
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 20)
            }
            .refreshable { await appState.refreshAll() }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task {
            while !Task.isCancelled {
                await appState.refreshJobs()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}

struct JobCard: View {
    let job: GenerationJobDTO

    private var color: Color {
        switch job.status {
        case "success": SCTheme.success
        case "error", "canceled": SCTheme.danger
        default: SCTheme.warning
        }
    }

    private var status: String {
        switch job.status {
        case "queued": "排队中"
        case "running": "生成中"
        case "success": "已完成"
        case "canceled": "已取消"
        case "error": "失败"
        default: job.status
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(job.displayTitle).font(.headline).foregroundStyle(SCTheme.text)
                    Text("\(job.provider) · \(job.model)").font(.caption).foregroundStyle(SCTheme.muted)
                }
                Spacer()
                StatusPill(text: status, color: color)
            }
            if !job.isFinished {
                ProgressView(value: min(max(job.progress, 0), 100), total: 100)
                    .tint(SCTheme.purple)
                HStack {
                    Text(job.status == "queued" ? "等待执行" : "正在生成媒体")
                    Spacer()
                    Text("\(Int(job.progress))%")
                }
                .font(.caption)
                .foregroundStyle(SCTheme.muted)
            }
            if let error = job.error, !error.isEmpty {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(SCTheme.danger)
            }
        }
        .scCard()
    }
}
