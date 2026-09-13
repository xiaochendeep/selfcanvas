import Foundation

enum APIClientError: LocalizedError {
    case invalidServerURL
    case invalidResponse
    case unauthorized
    case server(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: "服务器地址无效"
        case .invalidResponse: "服务器返回了无法识别的数据"
        case .unauthorized: "账号或密码不正确"
        case let .server(_, message): message
        }
    }
}

struct APIClient {
    let baseURL: URL
    let token: String?
    var session: URLSession = .shared

    init(serverURL: String, token: String? = nil, session: URLSession = .shared) throws {
        let normalized = serverURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: normalized), let scheme = url.scheme, ["http", "https"].contains(scheme) else {
            throw APIClientError.invalidServerURL
        }
        self.baseURL = url
        self.token = token
        self.session = session
    }

    static func login(serverURL: String, username: String, password: String) async throws -> AuthSessionDTO {
        let client = try APIClient(serverURL: serverURL)
        return try await client.request(
            path: "/api/auth/login",
            method: "POST",
            body: AuthLoginPayload(username: username, password: password)
        )
    }

    func refresh(refreshToken: String) async throws -> AuthSessionDTO {
        let client = try APIClient(serverURL: baseURL.absoluteString)
        return try await client.request(
            path: "/api/auth/refresh",
            method: "POST",
            body: AuthRefreshPayload(refreshToken: refreshToken)
        )
    }

    func logout(refreshToken: String) async throws {
        let _: LogoutEnvelope = try await request(
            path: "/api/auth/logout",
            method: "POST",
            body: AuthRefreshPayload(refreshToken: refreshToken)
        )
    }

    func verifyAccess() async throws {
        let _: CanvasesEnvelope = try await request(path: "/api/v2/canvases", queryItems: [.init(name: "limit", value: "1")])
    }

    func fetchCapabilities() async throws -> MobileCapabilitiesDTO {
        try await request(path: "/api/mobile/config")
    }

    func fetchCanvases(limit: Int = 50) async throws -> CanvasesEnvelope {
        try await request(path: "/api/v2/canvases", queryItems: [.init(name: "limit", value: String(limit))])
    }

    func fetchCanvas(id: String, limit: Int = 50) async throws -> CanvasDetailEnvelope {
        try await request(path: "/api/v2/canvases/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)", queryItems: [.init(name: "limit", value: String(limit))])
    }

    func fetchJobs() async throws -> [GenerationJobDTO] {
        try await request(path: "/api/mobile/jobs")
    }

    func fetchArtifacts() async throws -> [ArtifactDTO] {
        try await request(path: "/api/mobile/artifacts")
    }

    func createJob(_ payload: GenerationRequest) async throws -> GenerationJobDTO {
        try await request(path: "/api/generation/jobs", method: "POST", body: payload)
    }

    func cancelJob(id: String) async throws -> GenerationJobDTO {
        try await request(path: "/api/generation/jobs/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)/cancel", method: "POST", body: EmptyPayload())
    }

    func absoluteURL(for path: String?) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        if let direct = URL(string: path), direct.scheme != nil { return direct }
        return URL(string: path, relativeTo: baseURL)?.absoluteURL
    }

    private func request<Response: Decodable>(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        body: (any Encodable)? = nil
    ) async throws -> Response {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIClientError.invalidServerURL
        }
        components.path = path
        if !queryItems.isEmpty { components.queryItems = queryItems }
        guard let url = components.url else { throw APIClientError.invalidServerURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Request-Id")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
        if http.statusCode == 401 { throw APIClientError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            let message = Self.errorMessage(from: data) ?? "服务器错误（\(http.statusCode)）"
            throw APIClientError.server(status: http.statusCode, message: message)
        }

        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw APIClientError.invalidResponse
        }
    }

    private static func errorMessage(from data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let message = object["message"] as? String { return message }
        if let error = object["error"] as? String { return error }
        if let error = object["error"] as? [String: Any], let message = error["message"] as? String { return message }
        return nil
    }
}

private struct EmptyPayload: Encodable {}
private struct AuthLoginPayload: Encodable {
    let username: String
    let password: String
}
private struct AuthRefreshPayload: Encodable {
    let refreshToken: String
}
private struct LogoutEnvelope: Decodable {
    let ok: Bool
}

private struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void

    init(_ value: any Encodable) {
        encodeValue = value.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeValue(encoder)
    }
}
