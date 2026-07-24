# Venture Android — AI Tool Desktop 移动端移植版

基于 [Venture GUI](https://github.com/venture) 的 Android APK 移植，将 Electron 桌面应用改造为 Tauri v2 + Android WebView 架构，实现 H5 前端 + Rust 后端同进程运行的移动端 AI 助手。

---

## 项目概述

Venture 是一个 AI Agent 平台桌面应用，提供 AI 对话、多模型管理、工作区编排等功能。本仓库是其 Android APK 移植版本。

### 技术栈对比

| 层级    | 原版 (Venture-main)                        | 移植版 (Venture-android)                 |
| ----- | ---------------------------------------- | ------------------------------------- |
| 壳层    | Electron 37                              | Tauri v2                              |
| 前端    | React 18 + TypeScript + Tailwind + Vite  | **复用，无改动**                            |
| 后端    | Rust + Axum + Tokio（独立 .exe 进程）          | **复用，编译为 .so 嵌入 APK**                 |
| 通信    | Electron IPC (contextBridge) → spawn 子进程 | 前端 `fetch()` → `localhost:49527` HTTP |
| 状态管理  | Zustand                                  | **复用**                                |
| UI 组件 | shadcn/ui (Radix UI)                     | **复用**                                |

### 架构变化

```
原版                                   移植版
────                                    ────
┌──────────┐  IPC   ┌─────────────┐    ┌──────────┐  HTTP   ┌──────────────┐
│ Electron │◄──────►│ Rust .exe   │    │ Android  │◄───────►│ Rust .so     │
│ Browser  │ spawn  │ (独立进程)   │    │ WebView  │ fetch() │ (同进程嵌入)  │
│ Window   │        │ :49527      │    │ 加载 H5  │         │ :49527       │
└──────────┘        └─────────────┘    └──────────┘         └──────────────┘
```

核心差异：

- **不再 spawn 子进程**：Rust 后端通过 Tauri 的 tokio runtime 同进程启动
- **IPC 替换为直接 HTTP**：前端 fallback 机制已原生支持，无需改动前端代码
- **桌面专属功能移除**：BrowserView、自定义标题栏、窗口控制等在移动端不可用

---

## 环境要求

| 环境                  | 版本要求           | 用途                           |
| ------------------- | -------------- | ---------------------------- |
| Node.js             | 18.0+          | 前端构建                         |
| Rust                | 1.97+ (stable) | 编译 Rust 后端                   |
| Android SDK         | API 34+        | APK 编译                       |
| Android NDK         | 29.x           | Rust 交叉编译 C 依赖 (ring/rustls) |
| JDK                 | 17+            | Gradle 构建                    |
| Windows/macOS/Linux | —              | 构建主机（当前在 Windows 上验证）        |

---

## 快速开始

### 1. 安装依赖

```bash
cd Venture-android
npm install
```

### 2. 添加 Rust Android 编译目标

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi
```

### 3. 一键打包

```bash
# Git Bash
npm run build:android

# Windows CMD / 双击
build-apk.cmd
```

构建产物：

- `Venture-release.apk` — 未签名 APK（7.8MB）
- `Venture-release-signed.apk` — Debug 签名 APK（可直接安装）

### 4. 安装到设备

```bash
adb install Venture-release-signed.apk
```

---

## 项目结构

```
Venture-android/
├── src/                          # React 前端（复用原版）
│   └── app/
│       ├── components/           # UI 组件
│       ├── services/             # API 服务层
│       ├── store/                # Zustand 状态管理
│       └── utils/                # 工具函数
│
├── backend/                      # Rust 后端（改造为 library crate）
│   ├── Cargo.toml                # + [lib] section
│   └── src/
│       ├── lib.rs                # [NEW] 可被 Tauri 调用的 run_server()
│       ├── main.rs               # [MOD] 薄包装 → run_server(None)
│       ├── config.rs             # [MOD] app_data_dir 接受可选覆盖
│       ├── app_data.rs           # [MOD] load() 接受可选数据目录
│       ├── chat.rs               # 不变：流式 SSE 处理
│       ├── crypto.rs             # 不变：AES-256-GCM 加密存储
│       ├── error.rs              # 不变：统一错误类型
│       └── provider.rs           # 不变：Provider/Model 数据结构
│
├── src-tauri/                    # Tauri v2 壳层
│   ├── Cargo.toml                # tauri 2.x + venture-backend 依赖
│   ├── tauri.conf.json           # Tauri + Android 配置
│   ├── build.rs                  # tauri_build
│   ├── capabilities/default.json # 权限声明
│   ├── icons/                    # 应用图标（RGBA PNG）
│   ├── gen/android/              # 生成的 Android Gradle 项目
│   └── src/
│       ├── main.rs               # 桌面入口
│       └── lib.rs                # 移动端入口（#[cfg_attr(mobile, ...)]）
│
├── .cargo/config.toml            # Android NDK 交叉编译 linker 配置
├── Cargo.toml                    # Rust workspace
├── build-apk.sh                  # 一键打包脚本 (bash)
├── build-apk.cmd                 # 一键打包脚本 (CMD)
├── package.json                  # 前端依赖 + 构建脚本
├── vite.config.ts                # Vite 配置
└── index.html                    # SPA 入口
```

---

## 移植版注意事项

### 后端改造（backend/）

1. **library crate 化**：原版 `backend/` 是纯 binary crate（`[[bin]]`），移植版新增 `[lib]` section，`lib.rs` 导出 `pub async fn run_server(data_dir: Option<PathBuf>)`。独立运行时仍可通过 `main.rs` 启动。

2. **数据目录可配置**：`config.rs` 的 `app_data_dir()` 和 `AppDataStore::load()` 接受可选 `override_dir` 参数。Tauri 壳传入 `app.path().app_data_dir()` 确保配置存储在 Android 的 `/data/data/com.venture.app/files/Venture/` 下。

3. **tracing 重复初始化**：`run_server()` 中 `tracing_subscriber::fmt().init()` 改为 `.try_init().ok()`。因为 Tauri 已初始化全局 subscriber，重复 `.init()` 会导致 panic。

4. **CORS 白名单扩展**：新增 `https://tauri.localhost` 和 `file://` 来源，适配 Android WebView 的 origin 模式。

### 壳层（src-tauri/）

5. **Tauri 版本锁定**：使用 `tauri = { version = "2" }`（最新 2.x）。旧版 Tauri（2.10.3）与新 Rust 编译器（1.97+）不兼容。

6. **图标必须为 RGBA PNG**：`generate_context!()` 在运行时验证图标尺寸与像素数据匹配。32x32 图标需 1024 像素，128x128 需 65536 像素，颜色类型必须为 RGBA（type 6）。

7. **插件裁剪**：移除了 `tauri-plugin-shell/dialog/process/notification`，移动端不需要这些桌面插件。`capabilities/default.json` 只保留 `core:default`。

### 构建系统

8. **Android NDK Clang**：NDK 29 缺少无 API 后缀的 clang 别名（如 `aarch64-linux-android-clang`），需手动创建 `.cmd` wrapper 指向 `aarch64-linux-android35-clang.cmd`。

9. **`.cargo/config.toml` linker 路径**：Windows 上必须使用绝对路径 + `.cmd` 后缀，如 `linker = "C:/.../aarch64-linux-android35-clang.cmd"`。

10. **Gradle Maven 镜像**：`build.gradle.kts` 中 `google()` 和 `mavenCentral()` 添加了阿里云镜像前置，解决国内网络无法访问 Google Maven 的问题。

11. **APK 签名**：构建脚本使用 `~/.android/debug.keystore` 自动签名（密码 `android`，别名 `androiddebugkey`）。正式发布需替换为正式签名。

12. **前端 assets 打包**：构建脚本将 `dist/web/` 复制到 `app/src/main/assets/`，确保 WebView 能加载 `index.html`。

### 前端适配（无需改动）

13. **desktopShell fallback**：前端 `backendClient.ts` 已有 `window.desktopShell` 不存在时的 HTTP fallback 机制（`http://127.0.0.1:49527`），在 Android WebView 中自动生效。

14. **BrowserPanel 降级**：非 Electron 环境自动显示"内置浏览器需要桌面端"提示，不影响核心 AI 对话功能。

15. **CustomTitleBar 隐藏**：`ChatHeader.tsx` 中通过 `__IS_ELECTRON__` 条件渲染，Tauri 构建中此标志为 false，标题栏不渲染。

### 已知限制

| 功能     | 原版  | 移植版 | 说明                       |
| ------ |:---:|:---:| ------------------------ |
| AI 对话  | ✓   | ✓   | 完整支持                     |
| 多模型管理  | ✓   | ✓   | 完整支持                     |
| 应用设置   | ✓   | ✓   | 完整支持                     |
| 内置浏览器  | ✓   | ✗   | BrowserView 不可用，显示降级提示   |
| 窗口控制   | ✓   | ✗   | 移动端无窗口概念                 |
| 桌面通知   | ✓   | ✗   | 待集成 Android Notification |
| 文件系统访问 | ✓   | ✗   | 待实现 Android SAF          |
| 无障碍服务  | ✗   | 待实现 | 架构已预留 tool call 扩展点      |
| 截屏/悬浮窗 | ✗   | 待实现 | 需 AndroidManifest 权限声明   |

---

## 标准化 API

与桌面版完全兼容的 REST API（后端 `run_server()` 启动）：

| 方法       | 路径                      | 说明                   |
| -------- | ----------------------- | -------------------- |
| `GET`    | `/health`               | 健康检查，返回 nonce/pid/版本 |
| `GET`    | `/api/providers`        | 列出已配置的 AI Provider   |
| `POST`   | `/api/providers`        | 添加 Provider          |
| `PATCH`  | `/api/providers/:id`    | 更新 Provider          |
| `DELETE` | `/api/providers/:id`    | 删除 Provider          |
| `GET`    | `/api/app-data`         | 读取应用数据               |
| `PUT`    | `/api/app-data`         | 覆盖应用数据               |
| `PATCH`  | `/api/app-data`         | 增量更新应用数据             |
| `POST`   | `/api/app-data/migrate` | 数据迁移                 |
| `POST`   | `/api/chat/stream`      | 流式 AI 对话 (SSE)       |

后端端口：`127.0.0.1:49527`（可通过 `VENTURE_BACKEND_PORT` 环境变量覆盖）

---

## 开发命令速查

```bash
# 前端开发
npm run dev                # Vite dev server (port 5174)

# 构建
npm run build:tauri        # 仅构建前端
npm run build:android      # 一键打包 APK (bash)
build-apk.cmd              # 一键打包 APK (CMD)

# 安装测试
adb install Venture-release-signed.apk
adb logcat -s VentureApp:* # 查看应用日志
```

---

## 对话内容协议

前端 `Message.content` 使用标签协议承载思考链、错误、附件等结构化内容。详细规范见原项目 `AI_COLLAB_SPEC.md`。

关键标签：

- `[thinking]...[/thinking]` — 模型推理链
- `[error][code]...[/code][message]...[/message][/error]` — 错误信息
- `[ask]...[option]...[textinput]...[/ask]` — Ask Tool 用户交互
- `[attachment]...[/attachment]` — 附件引用

解析器：`src/app/utils/messageContentProtocol.ts`，负责白名单解析、嵌套序列化和流式容错。

---

## 技术栈

| 层级    | 技术                                          |
| ----- | ------------------------------------------- |
| 壳层    | Tauri v2                                    |
| 前端    | React 18 + TypeScript + Tailwind CSS + Vite |
| 后端    | Rust + Axum + Tokio                         |
| 状态管理  | Zustand                                     |
| UI 组件 | shadcn/ui (Radix UI)                        |
| 加密    | AES-256-GCM                                 |
| 桌面    | Electron 37（原版保留）                           |

---

## 许可证

MIT
