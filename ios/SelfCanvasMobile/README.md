# SelfCanvas Mobile

SelfCanvas iPhone 内测版，使用 SwiftUI，最低系统 iOS 17。

## 当前范围

- 内部账号密码登录，短期访问令牌自动刷新，刷新凭据写入 Keychain。
- 创作、项目、任务、资产四个主页面。
- 图片、视频、音频和 AI 导演生成配置。
- 视频支持生成、AI 剪辑、直接合并和 AnyCap 创意改编。
- 读取服务器画布、任务与输出资产。
- 通过 Bearer Token 提交和取消生成任务。
- 无服务器时可进入离线演示，完整查看首版交互。

## 打开与运行

1. 使用 Xcode 打开 `SelfCanvasMobile.xcodeproj`。
2. 选择 `SelfCanvasMobile` Scheme 与一个 iPhone 模拟器。
3. 运行 App。
4. 登录页填写 SelfCanvas 服务器地址和服务器配置的内部账号密码。

服务器至少配置：

```bash
SELF_CANVAS_MOBILE_USERNAME=internal
SELF_CANVAS_MOBILE_PASSWORD=请设置独立长密码
SELF_CANVAS_MOBILE_AUTH_SECRET=请设置随机长密钥
```

若未配置 `SELF_CANVAS_MOBILE_PASSWORD`，首个兼容版本会临时回退到 `SELF_CANVAS_API_TOKEN`，不建议给测试用户长期使用这种方式。

模拟器连接本机服务可以使用 `http://127.0.0.1:8787`。真机需要填写 Mac 或 Windows 主机的局域网地址，并确保防火墙放行 8787 端口。

## 命令行构建

```bash
xcodebuild \
  -project SelfCanvasMobile.xcodeproj \
  -scheme SelfCanvasMobile \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

首版为内部验证构建。正式 TestFlight 前还需要配置 App 图标、开发团队、推送通知、隐私清单和生产账号体系。
