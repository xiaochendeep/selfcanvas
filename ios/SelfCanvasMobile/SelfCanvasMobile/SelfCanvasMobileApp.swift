import SwiftUI

@main
struct SelfCanvasMobileApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            AppRootView()
                .environmentObject(appState)
                .preferredColorScheme(.dark)
        }
    }
}
