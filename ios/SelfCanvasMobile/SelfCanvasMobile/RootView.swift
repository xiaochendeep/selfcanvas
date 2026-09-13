import SwiftUI

struct AppRootView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        Group {
            if appState.isAuthenticated {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .tint(SCTheme.purple)
    }
}

struct MainTabView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        TabView(selection: $appState.selectedTab) {
            NavigationStack { CreateView() }
                .tabItem { Label(AppTab.create.title, systemImage: AppTab.create.symbol) }
                .tag(AppTab.create)

            NavigationStack { ProjectsView() }
                .tabItem { Label(AppTab.projects.title, systemImage: AppTab.projects.symbol) }
                .tag(AppTab.projects)

            NavigationStack { TasksView() }
                .tabItem { Label(AppTab.tasks.title, systemImage: AppTab.tasks.symbol) }
                .badge(appState.jobs.filter { !$0.isFinished }.count)
                .tag(AppTab.tasks)

            NavigationStack { AssetsView() }
                .tabItem { Label(AppTab.assets.title, systemImage: AppTab.assets.symbol) }
                .tag(AppTab.assets)
        }
        .toolbarBackground(SCTheme.surface, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .task { await appState.refreshAll() }
    }
}
