# Backend 后端

Rust 后端应用程序的代码组织结构。遵循分层架构设计。

## 目录结构

```
backend/src/
├── main.rs              # 应用入口点
├── lib.rs               # 库根模块
├── config/              # 配置管理
├── models/              # 数据模型和类型
├── services/            # 业务逻辑层
├── api/                 # API 路由和处理器
├── crypto/              # 加密相关功能
├── utils/               # 工具函数
└── error.rs             # 全局错误处理
```

## 各层说明

### Config 层 (`config/`)
应用程序配置和环境管理。

**文件：**
- `mod.rs` - 模块声明和导出
- `environment.rs` - 环境变量和配置

**职责：**
- 加载和验证配置
- 管理环境变量
- 提供配置访问接口

### Models 层 (`models/`)
定义应用程序中使用的数据结构和类型。

**文件：**
- `mod.rs` - 模块声明和导出
- `chat.rs` - 聊天相关数据模型
- 其他数据模型文件

**指南：**
- 使用 `#[derive(...)]` 进行序列化/反序列化
- 添加文档注释说明每个字段
- 使用有意义的类型（避免过度使用 String）

**例子：**
```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub content: String,
    pub role: MessageRole,
}
```

### Services 层 (`services/`)
包含应用程序的业务逻辑。

**文件：**
- `mod.rs` - 模块声明和导出
- `chat.rs` - 聊天服务逻辑
- `provider.rs` - 模型提供者服务

**职责：**
- 实现业务逻辑
- 数据处理和验证
- 与外部系统交互
- 不涉及 HTTP 处理细节

**指南：**
- 服务应该是可测试的
- 使用 async/await 进行异步操作
- 返回 `Result<T, Error>` 处理错误

**例子：**
```rust
pub struct ChatService {
    client: ChatClient,
}

impl ChatService {
    pub async fn send_message(&self, msg: &str) -> Result<String> {
        // 业务逻辑
        Ok(response)
    }
}
```

### API 层 (`api/`)
处理 HTTP 请求和响应。

**文件：**
- `mod.rs` - 模块声明和路由配置
- `handlers.rs` - 请求处理器
- `routes.rs` - 路由定义
- `extractors.rs` - 自定义提取器（如果需要）

**职责：**
- 解析 HTTP 请求
- 调用服务层
- 格式化响应
- 错误转换为 HTTP 响应

**指南：**
- 一个处理器函数处理一个端点
- 使用提取器解析请求数据
- 返回合适的 HTTP 状态码

**例子：**
```rust
#[post("/chat/send")]
pub async fn send_chat_message(
    Json(payload): Json<ChatRequest>,
    State(service): State<Arc<ChatService>>,
) -> Result<Json<ChatResponse>> {
    let response = service.send_message(&payload.text).await?;
    Ok(Json(ChatResponse { text: response }))
}
```

### Crypto 层 (`crypto/`)
加密相关的功能。

**文件：**
- `mod.rs` - 模块声明和导出
- `crypto.rs` - 加密实现

**职责：**
- 数据加密/解密
- 哈希生成
- 密钥管理

### Utils 层 (`utils/`)
通用工具函数。

**文件：**
- `mod.rs` - 模块声明和导出
- `helpers.rs` - 助手函数

**职责：**
- 字符串处理
- 日期/时间操作
- 日志记录
- 其他通用工具

### Error 处理 (`error.rs`)
全局错误类型定义。

**内容：**
- 应用程序错误枚举
- 错误到 HTTP 响应的转换
- 错误信息本地化

**例子：**
```rust
#[derive(Debug)]
pub enum AppError {
    ChatError(String),
    ConfigError(String),
    ValidationError(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // 转换为 HTTP 响应
    }
}
```

## 数据流

```
Request
  ↓
API Layer (handlers.rs) - 解析请求
  ↓
Services Layer (services/) - 业务逻辑
  ↓
Models Layer (models/) - 数据处理
  ↓
Response
```

## 最佳实践

### 1. 分层原则
- **不要越级调用** - API 只能调用 Services，不能直接访问 Models
- **数据流向下** - 上层依赖下层，不要反向依赖

### 2. 错误处理
- 使用 `Result<T>` 处理可能失败的操作
- 不要使用 `.unwrap()`，除非确定不会出错
- 提供有意义的错误信息

```rust
// ✅ 好的做法
pub async fn do_something() -> Result<Data> {
    let data = fetch_data()
        .await
        .map_err(|e| AppError::FetchError(e.to_string()))?;
    Ok(data)
}

// ❌ 不好的做法
pub async fn do_something() -> Data {
    fetch_data().await.unwrap()
}
```

### 3. 异步编程
- 使用 `tokio` 处理异步操作
- 在服务层使用 async 函数
- 避免阻塞调用

### 4. 类型安全
- 充分利用 Rust 的类型系统
- 使用 newtype 模式防止类型混淆
- 尽量避免 `String` 和 `Option` 的过度使用

```rust
// ✅ 好的做法
pub struct UserId(String);
pub struct ChatId(String);

// ❌ 不好的做法
pub fn get_chat(user_id: String, chat_id: String) {}
```

### 5. 依赖注入
- 通过构造函数注入依赖
- 在 Axum State 中传递共享资源

```rust
pub struct AppState {
    chat_service: Arc<ChatService>,
    config: Config,
}
```

## 迁移指南

当前 backend/src/ 中的文件应该按以下方式组织：

1. **现有文件映射：**
   - `chat.rs` → `services/chat.rs`
   - `provider.rs` → `services/provider.rs`
   - `config.rs` → `config/environment.rs`
   - `crypto.rs` → `crypto/crypto.rs`
   - `error.rs` → `error.rs`（保留根目录）

2. **创建新文件：**
   - `lib.rs` - 库根模块
   - `api/handlers.rs` - API 处理器
   - `api/routes.rs` - 路由配置
   - `models/chat.rs` - 数据模型
   - `models/error.rs` - 错误模型

## 编译检查

```bash
# 检查代码
cargo check

# 运行测试
cargo test

# 构建发行版
cargo build --release
```

## 注意事项

- 每个模块都应该有 `mod.rs` 文件
- 在 `mod.rs` 中声明子模块
- 使用 `pub use` 重导出公共 API
- 保持模块间的清晰边界
- 避免循环依赖
