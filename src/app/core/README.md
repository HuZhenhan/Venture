# Core Module

核心模块包含应用程序的基础业务逻辑和基础设施。

## 目录结构

### `services/`
包含应用程序级别的服务，主要用于与后端 API 通信和外部服务交互。

**当前服务：**
- `backendClient.ts` - 后端 API 客户端（HTTP 通信）
- `chatStreamService.ts` - 聊天流服务（处理流式响应）
- `modelConfigService.ts` - 模型配置服务（管理模型配置）

**扩展指南：**
- 每个服务应该暴露一个清晰的 API
- 避免在服务中放入 UI 逻辑
- 使用单例模式或工厂模式创建服务实例

### `hooks/`
包含全局的、可复用的 React hooks，通常与状态管理或服务交互。

**指南：**
- 名称以 `use` 开头
- 只包含逻辑，不包含 UI
- 可以在任何地方使用，不仅限于特定功能

### `types.ts`
定义全局类型和接口，所有模块都可以使用。

## 何时使用 Core 模块

✅ 应该放在 Core：
- 跨多个功能模块使用的服务
- 全局状态相关的 hooks
- 全局类型和常量
- 通用的工具函数

❌ 不应该放在 Core：
- 特定功能的组件（应该在 features 中）
- 特定功能的 hooks（应该在 features 中）
- 特定功能的状态管理（应该在 features 中）

## 最佳实践

1. **保持 Core 模块精简** - 只包含真正共用的代码
2. **明确的接口** - 每个服务应该有清晰的公共 API
3. **错误处理** - 在服务层处理错误，提供有意义的错误信息
4. **类型安全** - 尽可能使用 TypeScript 类型
5. **文档** - 在 services 中添加 JSDoc 注释

## 例子

### 添加新服务

```typescript
// src/app/core/services/myService.ts
export class MyService {
  async doSomething(): Promise<Result> {
    // 实现逻辑
  }
}

export const myService = new MyService();
```

### 在组件中使用

```typescript
import { myService } from '@/app/core/services/myService';

function MyComponent() {
  useEffect(() => {
    myService.doSomething();
  }, []);
}
```
