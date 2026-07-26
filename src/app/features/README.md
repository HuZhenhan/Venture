# Features Module

功能模块包含与特定业务功能相关的所有代码。每个功能都应该是自包含的，尽可能减少对其他功能的依赖。

## 目录结构

每个功能模块（如 `chat`, `settings` 等）都应该遵循以下结构：

```
features/
├── chat/
│   ├── components/           # 聊天特定的 React 组件
│   ├── hooks/               # 聊天特定的 hooks
│   ├── store/               # 聊天特定的状态管理
│   ├── utils/               # 聊天特定的工具函数
│   ├── types.ts             # 聊天特定的类型定义
│   └── index.ts             # 导出入口（可选）
│
├── settings/
│   ├── components/
│   ├── hooks/
│   ├── store/
│   ├── types.ts
│   └── index.ts
│
└── theme/
    ├── components/
    ├── store/
    ├── constants.ts
    └── index.ts
```

## 各功能简介

### Chat 聊天功能
处理所有与聊天相关的功能：
- 消息显示和输入
- 聊天历史
- 代码引用和搜索卡片

**关键文件：**
- `components/` - ChatHeader, MessageList, ChatInput 等
- `store/` - 聊天消息状态管理
- `hooks/` - useGeneration, useChatComposer, useChatScroll 等

### Workspace 工作区功能
_已从项目中移除。_

### Settings 设置功能
处理应用程序设置：
- 用户偏好
- 模型配置
- 主题设置（虽然有专门的 theme 模块）

**关键文件：**
- `components/` - SettingsSidebarPanels 等
- `store/` - usePreferencesStore 等

### Theme 主题功能
专门处理应用程序主题：
- 暗黑模式切换
- 主题变量管理

**关键文件：**
- `store/` - useThemeStore
- `constants.ts` - 主题常量

## 最佳实践

### 1. 模块独立性
- 每个功能应该是独立的
- 最小化与其他功能的交叉依赖
- 如果需要数据，通过 core 服务或全局 store 获取

### 2. 文件组织
```typescript
// ✅ 好的做法
import { ChatMessage } from '@/app/features/chat/types';
import { useChatStore } from '@/app/features/chat/store';
import { ChatInput } from '@/app/features/chat/components/ChatInput';

// ❌ 不好的做法
import { ChatMessage } from '@/app/features/chat/store/slices/types';
import chatStore from '@/app/features/chat/store';
```

### 3. 类型定义
- 在 `types.ts` 中定义该模块的所有类型
- 导出给其他模块使用
- 不要在组件文件中定义类型

### 4. 状态管理
- 使用 Zustand 管理功能特定的状态
- 状态文件放在 `store/` 目录下
- 一个文件一个 store（或使用索引文件导出多个）

### 5. 导出约定
```typescript
// src/app/features/chat/index.ts
export * from './components';
export * from './hooks';
export * from './store';
export * from './types';
export * from './utils';
```

### 6. 避免循环依赖
```typescript
// ❌ 不要这样做
// features/chat/components/ChatInput.tsx
import { OtherFeature } from '@/app/features/other/components';

// features/other/hooks/useOther.ts
import { useChatStore } from '@/app/features/chat/store';

// 这会导致循环依赖！
```

## 何时创建新功能

考虑以下因素：

✅ 创建新功能当：
- 有一组相关的组件、逻辑和状态
- 这些代码可能被重用
- 功能是独立的业务单元
- 团队中不同成员会同时开发

❌ 不需要创建新功能当：
- 只是一个小组件或工具函数
- 功能高度依赖其他模块
- 只在一个地方使用

## 通信模式

### 同一功能内的通信
```typescript
// 直接导入使用
import { useChatStore } from '@/app/features/chat/store';
import { ChatMessage } from '@/app/features/chat/types';
```

### 不同功能间的通信
```typescript
// 通过 core 服务
import { chatService } from '@/app/core/services/chatService';

// 或通过全局 store
import { useLayoutStore } from '@/app/store/useLayoutStore';
```

### 父组件向子组件传递数据
```typescript
// 使用 props
<ChatInput onSend={handleSend} />
```

## 迁移现有代码

当前项目中的代码应该按以下方式迁移：

1. **Chat 相关**
   - `components/chat/` → `features/chat/components/`
   - `hooks/useGeneration.ts` → `features/chat/hooks/`
   - `hooks/useChatComposer.ts` → `features/chat/hooks/`
   - `hooks/useChatScroll.ts` → `features/chat/hooks/`

2. **Settings 相关**
   - `components/SettingsSidebar.tsx` → `features/settings/components/`

3. **Theme 相关**
   - `store/useThemeStore.ts` → `features/theme/store/`

## 检查清单

创建新功能时：
- [ ] 创建了 `components`, `hooks`, `store`, `utils` 目录（如需要）
- [ ] 创建了 `types.ts` 文件
- [ ] 创建了 `index.ts` 导出文件
- [ ] 创建了 `README.md` 说明文档
- [ ] 所有类型都在 `types.ts` 中定义
- [ ] 所有状态都在 `store/` 中定义
- [ ] 没有循环依赖
- [ ] 代码可以独立测试
