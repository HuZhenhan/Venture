# Venture GUI - AI Tool Desktop Application

A modern, full-stack Electron desktop application for AI-powered code assistance and chat interface.

**[🗂️ 查看项目结构优化报告](./STRUCTURE_OPTIMIZATION_REPORT.md)** | **[📚 完整文档](./docs/README.md)** | **[🏗️ 项目架构](./docs/ARCHITECTURE.md)**

## 📋 快速开始

### 前置要求
- Node.js 18+
- Rust 最新版本
- Windows (当前配置为 x86_64-pc-windows-gnu)

### 安装和运行

```bash
# 安装依赖
npm install

# 开发模式（同时启动前端、Electron、后端）
npm run dev

# 单独运行后端
npm run dev:backend

# 构建生产版本
npm run build

# 构建便携版本
npm run build:portable
```

## 📚 文档导航

### 🎯 新手入门
- **[快速开始指南](./docs/DEVELOPMENT.md#快速开始)** - 5 分钟快速上手
- **[项目结构](./PROJECT_STRUCTURE.md)** - 理解项目组织
- **[文档索引](./docs/README.md)** - 找到你需要的文档

### 🏗️ 深入理解
- **[系统架构](./docs/ARCHITECTURE.md)** - 了解系统设计和数据流
- **[开发指南](./docs/DEVELOPMENT.md)** - 完整的开发工作流
- **[结构优化报告](./STRUCTURE_OPTIMIZATION_REPORT.md)** - 详细的优化说明

### 💻 代码组织
- **[Core 模块](./src/app/core/README.md)** - 核心服务和基础设施
- **[Features 模块](./src/app/features/README.md)** - 功能模块组织
- **[后端架构](./backend/README.md)** - Rust 后端分层设计

### 🤝 参与贡献
- **[贡献指南](./docs/CONTRIBUTING.md)** - 如何为项目做贡献
- **[迁移指南](./docs/MIGRATION.md)** - 代码迁移和重构

## 🚀 项目特性

- ✨ **现代化 UI** - React 18 + Tailwind CSS
- 🎨 **深色/浅色主题** - 完整的主题系统
- 🔧 **强大的后端** - Rust + Axum 高性能
- 🖥️ **跨平台** - 基于 Electron
- 📦 **模块化架构** - 清晰的功能划分
- 📚 **完整文档** - 详尽的开发文档

## 🗂️ 项目结构

```
Venture GUI/
├── src/                        # 前端源代码（React）
│   └── app/
│       ├── core/              # 核心服务和 hooks
│       ├── features/          # 功能模块（chat、workspace、settings）
│       ├── components/        # UI 组件库
│       └── store/             # 全局状态管理
├── backend/                   # 后端源代码（Rust）
│   └── src/
│       ├── config/            # 配置管理
│       ├── models/            # 数据模型
│       ├── services/          # 业务逻辑
│       └── api/               # API 路由
├── electron/                  # Electron 主进程配置
├── docs/                      # 项目文档
│   ├── README.md             # 文档索引
│   ├── ARCHITECTURE.md       # 系统架构
│   ├── DEVELOPMENT.md        # 开发指南
│   ├── CONTRIBUTING.md       # 贡献指南
│   └── MIGRATION.md          # 迁移指南
└── scripts/                   # 构建脚本
```

### 前端功能模块

- **Chat** - 聊天界面和消息处理
- **Workspace** - 工作区和文件管理
- **Settings** - 应用设置和配置
- **Theme** - 主题管理系统

## 🛠️ 技术栈

### 前端
- React 18
- TypeScript
- Tailwind CSS
- Zustand (状态管理)
- Vite (构建工具)

### 后端
- Rust
- Axum (Web 框架)
- Tokio (异步运行时)
- Serde (序列化)

### 桌面
- Electron 37
- Electron Builder (打包)

## 📖 开发命令

```bash
# 开发相关
npm run dev                # 开发模式
npm run dev:backend       # 仅后端
npm run dev:web           # 仅前端
npm start                 # 启动 Electron

# 构建相关
npm run build             # 完整构建
npm run build:web         # 构建 Web
npm run build:desktop     # 构建桌面应用
npm run build:portable    # 构建便携版本

# 预览
npm run preview:web       # Web 预览
```

## 🎨 UI 组件

项目使用 shadcn/ui 提供的 Radix UI 组件库，包括：
- Button, Input, Dialog
- Card, Badge, Alert
- 和更多 30+ 个 UI 组件

所有组件都支持浅色和深色主题。

## 🔐 安全性

- 使用 Rust 的类型系统防止常见错误
- API 通信支持加密
- 敏感信息不存储在代码中

## 📊 项目统计

- **前端**: React + TypeScript
- **后端**: Rust + Axum
- **文档**: 8+ 个详尽指南
- **代码**: 完全模块化和可维护

## 🤝 贡献

欢迎为项目做出贡献！请查看 [贡献指南](./docs/CONTRIBUTING.md) 了解详情。

### 贡献流程
1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/xxx`)
3. 提交更改 (`git commit -m 'feat: xxx'`)
4. 推送到分支 (`git push origin feature/xxx`)
5. 创建 Pull Request

## 📝 许可证

MIT

## 🔗 相关链接

- [设计稿](https://www.figma.com/design/MWV9wugXackbDyWKsMcvBd/AI-Tool-Desktop-GUI)
- [React 文档](https://react.dev)
- [Rust 文档](https://doc.rust-lang.org)
- [Electron 文档](https://www.electronjs.org/docs)

## 📞 获取帮助

- 📖 查看 [文档索引](./docs/README.md)
- 🐛 报告 Bug: [创建 Issue](../../issues)
- 💬 提出建议: [讨论](../../discussions)

---

**想要快速开始？** 👉 [查看开发指南](./docs/DEVELOPMENT.md)

**想要了解架构？** 👉 [查看系统架构](./docs/ARCHITECTURE.md)

**想要贡献代码？** 👉 [查看贡献指南](./docs/CONTRIBUTING.md)
