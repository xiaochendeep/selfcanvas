import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var appState: AppState
    @State private var serverURL = SelfCanvasEnvironment.defaultServerURL
    @State private var username = "internal"
    @State private var password = ""
    @State private var showConnection = false
    @FocusState private var focusedField: Field?

    private enum Field { case username, password, server }

    var body: some View {
        ZStack {
            SCTheme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Spacer(minLength: 64)
                    ZStack {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(SCTheme.purple)
                            .frame(width: 62, height: 62)
                        Image(systemName: "circle.hexagongrid.fill")
                            .font(.title)
                            .foregroundStyle(.white)
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("欢迎使用 SelfCanvas")
                            .font(.largeTitle.weight(.bold))
                            .foregroundStyle(SCTheme.text)
                        Text("登录内部创作空间，继续你的项目。")
                            .foregroundStyle(SCTheme.muted)
                    }

                    VStack(spacing: 14) {
                        TextField("账号", text: $username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textContentType(.username)
                            .focused($focusedField, equals: .username)
                            .submitLabel(.next)
                            .onSubmit { focusedField = .password }
                            .padding(15)
                            .background(SCTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                        SecureField("密码", text: $password)
                            .textContentType(.password)
                            .focused($focusedField, equals: .password)
                            .submitLabel(.go)
                            .onSubmit { signIn() }
                            .padding(15)
                            .background(SCTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                        Button {
                            withAnimation(.easeInOut) { showConnection.toggle() }
                        } label: {
                            HStack {
                                Circle().fill(SCTheme.success).frame(width: 8, height: 8)
                                Text("内部测试环境")
                                Spacer()
                                Image(systemName: showConnection ? "chevron.up" : "chevron.down")
                            }
                            .frame(minHeight: 44)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(SCTheme.muted)

                        if showConnection {
                            TextField("服务器地址", text: $serverURL)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($focusedField, equals: .server)
                                .padding(15)
                                .background(SCTheme.surfaceRaised)
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .transition(.opacity.combined(with: .move(edge: .top)))
                        }

                        if let message = appState.errorMessage {
                            Label(message, systemImage: "exclamationmark.circle.fill")
                                .font(.footnote)
                                .foregroundStyle(SCTheme.danger)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        Button(action: signIn) {
                            Group {
                                if appState.isBusy {
                                    ProgressView().tint(.white)
                                } else {
                                    Text("登录").fontWeight(.semibold)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 52)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.white)
                        .background(SCTheme.purple)
                        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                        .disabled(appState.isBusy)

                        Button("先体验界面") {
                            appState.enterDemo()
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(SCTheme.muted)
                    }
                    .scCard()

                    Text("内测账号由 SelfCanvas 服务器配置。App 只把刷新凭据保存到本机 Keychain，不保存你的登录密码。")
                        .font(.caption)
                        .foregroundStyle(SCTheme.muted)
                    Spacer(minLength: 24)
                }
                .padding(.horizontal, 20)
            }
        }
    }

    private func signIn() {
        focusedField = nil
        Task { await appState.signIn(serverURL: serverURL, username: username, password: password) }
    }
}

private enum SelfCanvasEnvironment {
    static var defaultServerURL: String {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "SELFCANVAS_SERVER_URL") as? String,
           !configured.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return configured
        }
        return "http://192.168.43.6:8787"
    }
}
