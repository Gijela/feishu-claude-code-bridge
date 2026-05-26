# 多智能体协作系统 — 技术方案

## 1. 概述

将 lark-channel-bridge 从"单 agent 对话桥接"升级为"多 agent 协作平台"。用户在一个飞书群聊中，与多个角色 Agent 协同工作，Agent 之间可通过 @ 互相调度，人在关键节点决策。

### 当前架构局限

- 全局单个 `SwappableAgent` 实例
- `ActiveRuns` 按 scope 单 key，无法并行
- `runAgentBatch()` 写死单 agent 调用
- 无 agent 间消息路由

### 设计目标

- 多角色 Agent 共存，各自独立 session
- Agent 之间通过群聊 @ + 引用消息互调
- 支持并发执行（如 PM 和 Dev 同时工作）
- 人全程在群聊中可见、可干预
- 最小改动现有架构

---

## 2. 系统架构

```
                    ┌─────────────────────────┐
                    │    飞书群聊 (作战室)       │
                    │  @需求挖掘 @PM @Dev      │
                    │  @QA @增长               │
                    └──────────┬──────────────┘
                               │ WebSocket Events
                               ▼
                    ┌─────────────────────────┐
                    │     intakeMessage()       │
                    │     + 路由层 (新增)        │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │   AgentRegistry (新增)    │
                    │                         │
                    │  ┌───────────────────┐  │
                    │  │ 需求挖掘 Agent     │  │
                    │  ├───────────────────┤  │
                    │  │ PM Agent          │  │
                    │  ├───────────────────┤  │
                    │  │ Dev Agent         │  │
                    │  ├───────────────────┤  │
                    │  │ QA Agent          │  │
                    │  ├───────────────────┤  │
                    │  │ 增长 Agent         │  │
                    │  └───────────────────┘  │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │     ActiveRuns (增强)    │
                    │   scope → Map<role, Run> │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │   PendingQueue (增强)    │
                    │   per-scope, role-aware  │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │   CardRenderer (增强)    │
                    │   multi-agent 并排展示   │
                    └─────────────────────────┘
```

---

## 3. 核心数据结构

### 3.1 AgentRole — 角色定义

```typescript
// src/agent/role.ts (新增)

interface AgentRole {
  id: string;              // 'researcher' | 'pm' | 'dev' | 'qa' | 'growth'
  displayName: string;     // '需求挖掘' | '产品经理' | '开发' | '测试' | '运营增长'
  mentionName: string;     // '@需求挖掘' | '@PM' | '@Dev' | '@QA' | '@增长'
  description: string;     // 角色说明，注入 system prompt
  adapter: AgentAdapter;   // 底层 adapter (可复用 ClaudeAdapter/OpenCodeAdapter)
  systemPrompt?: string;   // 角色专属 system prompt 追加
  maxRoundTrip?: number;   // 最大循环次数（防死循环），默认 3
}
```

### 3.2 AgentRegistry — Agent 注册表

```typescript
// src/agent/registry.ts (新增)

class AgentRegistry {
  private roles = new Map<string, AgentRole>();

  register(role: AgentRole): void;
  get(roleId: string): AgentRole | undefined;
  getByMention(name: string): AgentRole | undefined;
  // "@Dev" → pm.mentionName → match
  // "@PM" → 同上
  list(): AgentRole[];

  // 根据消息内容自动匹配角色
  // 关键词启发式：'需求'→researcher, '方案'→pm, '开发'→dev, '测试'→qa, '增长'→growth
  matchRole(content: string): AgentRole | undefined;
}
```

### 3.3 ActiveRuns 增强

```typescript
// 改动: src/bot/active-runs.ts

// 当前: Map<scope, RunHandle>
// 改为: Map<scope, Map<roleId, RunHandle>>

class ActiveRuns {
  private handles = new Map<string, Map<string, RunHandle>>();

  register(scope: string, roleId: string, run: AgentRun): RunHandle;
  unregister(scope: string, roleId: string, run: AgentRun): void;
  interrupt(scope: string, roleId?: string): boolean;
  // roleId 可选 — 不传则中断该 scope 所有 agent
  getAllActive(scope: string): Map<string, RunHandle>;
  stopAll(): Promise<void>;
}
```

### 3.4 RouteContext — 路由上下文

```typescript
// 新增类型

interface RouteContext {
  targetRole?: AgentRole;     // 解析出的目标角色
  sourceRole?: string;        // 谁发的（如果是 agent 调 agent）
  roundTrip?: number;         // 当前循环轮次
  referencedMsg?: NormalizedMessage;  // 引用的消息
  mentionedRoles: string[];   // 消息中 @ 的所有角色
}
```

---

## 4. 消息路由层

### 4.1 路由逻辑

在 `intakeMessage()` 中，现有流程是：access check → mention check → tryHandleCommand → pending.push。

新增路由步骤：

```typescript
// 改造: src/bot/channel.ts → intakeMessage()

async function intakeMessage(deps) {
  // ... 现有 access control, mention check ...

  // === 新增: 多 agent 路由 ===
  const routeCtx = await resolveRoute(ctx, msg);
  // resolveRoute 逻辑:
  // 1. 解析 msg.content 中 @ 的角色名 → targetRole
  // 2. 检查 msg.mention 提取 sourceRole (agent 发的消息带 agent 标识)
  // 3. 检查引用消息获取上下文
  // 4. 提取 roundTrip 计数

  if (routeCtx.targetRole) {
    // 路由到指定 agent
    return routeToAgent(ctx, routeCtx);
  }

  // 没有 @ 任何 agent → 尝试自动匹配
  const autoMatched = registry.matchRole(msg.content);
  if (autoMatched) {
    return routeToAgent(ctx, { targetRole: autoMatched, ... });
  }

  // fallback: 默认 agent（用户在私聊或无 @ 时）
  // ... 现有 pending.push 逻辑 ...
}
```

### 4.2 路由到 Agent

```typescript
async function routeToAgent(ctx: CommandContext, route: RouteContext) {
  const { scope, targetRole } = route;

  // 检查是否已有该 agent 的活跃 run
  const existing = activeRuns.getAllActive(scope).get(targetRole.id);
  if (existing) {
    // 可打断当前 run（同现有行为）
    await activeRuns.interrupt(scope, targetRole.id);
  }

  // 构建 prompt（含群聊上下文、引用消息、角色 system prompt）
  const prompt = buildAgentPrompt(ctx, route);

  // 启动 agent
  const run = targetRole.adapter.run({
    prompt,
    sessionId: sessions.resumeFor(targetRole.id, scope, cwd),
    cwd,
    // 注入 agent 上下文到 system prompt
  });

  const handle = activeRuns.register(scope, targetRole.id, run);

  // 处理流（复用现有 processAgentStream）
  await processAgentStream(handle, targetRole.id, sessions, scope, cwd, ...);

  // 清理
  activeRuns.unregister(scope, targetRole.id, run);
}
```

---

## 5. Agent 自调度协议

### 5.1 协议定义

Agent 输出最后可以附带调度指令，格式在 system prompt 中约定：

```
## 调用其他 Agent

当需要其他角色继续工作时，在消息末尾添加一行：

🔀 @角色名 #round=N
[附加说明或引用]

规则：
- N 是当前轮次计数，从 1 开始
- 从其他 agent 收到消息时，round = 上游 round + 1
- 如果 round > 3（可配置），改为 @人 请求人工介入
- 引用消息可附在其后，作为上下文传递给下游 agent
```

### 5.2 调度指令解析

```typescript
// src/agent/dispatch.ts (新增)

interface DispatchDirective {
  targetRole: string;    // '@PM' | '@Dev' ...
  round: number;         // 当前轮次
  instruction?: string;  // 附加说明
  quoteMessageId?: string; // 引用消息 ID
}

function parseDispatch(text: string): DispatchDirective | null {
  // 匹配: 🔀 @角色名 #round=N
  // 或: @角色名 (简洁版)
  const match = text.match(/🔀\s*(@\w+)\s*#round=(\d+)/);
  if (!match) return null;
  return {
    targetRole: match[1],
    round: parseInt(match[2]),
  };
}
```

### 5.3 调度执行

在 `processAgentStream` 结束时，增加调度指令检查：

```typescript
// 改造: processAgentStream

async function processAgentStream(handle, roleId, ...) {
  // ... 现有事件循环 ...

  // Agent 正常结束后，检查是否触发调度
  if (state.terminal === 'done') {
    const dispatch = parseDispatch(lastText);
    if (dispatch) {
      const targetRole = registry.getByMention(dispatch.targetRole);

      if (dispatch.round > (targetRole?.maxRoundTrip ?? 3)) {
        // 超过最大循环 → @人介入
        await channel.send(chatId, {
          markdown: `⚠️ **${targetRole?.displayName}** 已重试 ${dispatch.round} 次仍未完成，请人工介入处理。`
        });
        return;
      }

      // 自动转发给目标 agent
      await routeToAgent(ctx, {
        targetRole,
        sourceRole: roleId,
        roundTrip: dispatch.round,
        referencedMsg: ...,
      });
    }
  }
}
```

---

## 6. Prompt 改造 — 群聊上下文注入

### 6.1 当前 prompt 结构

```
<bridge_context>
chat_id, chat_type, sender_id, sender_name, thread_id
</bridge_context>

<quoted_message ...>
  ...
</quoted_message>

用户消息
```

### 6.2 多 agent 增强

```typescript
function buildAgentPrompt(ctx, route: RouteContext): string {
  const parts = [
    // 1. Agent 角色定义
    `<agent_role>`,
    `你当前扮演的角色是：${route.targetRole.displayName}`,
    `${route.targetRole.description}`,
    `你的名字是 ${route.targetRole.mentionName}`,
    `注意：群聊中还有其他角色在协作。`,
    `当你需要其他角色继续工作时，在消息末尾以以下格式发出调度指令：`,
    `🔀 @其他角色名 #round=<当前轮次>`,
    `<可选的附加说明>`,
    `</agent_role>`,

    // 2. 群聊上下文（近 30 条消息，截取最近 + 引用相关）
    groupHistoryBlock(ctx.scope, ctx.msg.chatId, 30),

    // 3. 当前轮次
    route.roundTrip ? `<round>${route.roundTrip}</round>` : '',

    // 4. 引用消息
    route.referencedMsg ? renderReferencedMsg(route.referencedMsg) : '',

    // 5. 现有 bridge_context
    buildBridgeContextHeader(ctx.msg),

    // 6. 用户消息本体
    ctx.msg.content,
  ];

  return parts.filter(Boolean).join('\n\n');
}
```

### 6.3 群聊消息历史获取

```typescript
// 利用飞书 API 获取最近消息
// GET /im/v1/messages?container_id_type=chat&container_id={chatId}&page_size=30
// 过滤出纯文本消息，保留 sender 信息

async function fetchGroupHistory(
  channel: LarkChannel,
  chatId: string,
  limit: number
): Promise<string> {
  // 返回格式：
  // <history>
  // [sender_name] (@角色名): 消息内容
  // [sender_name] (@角色名): 消息内容
  // ...
  // </history>
}
```

---

## 7. QA→Dev 修复循环

### 7.1 状态机

```
Dev 完成编码
  │
  ▼
🔀 @QA #round=1 "验收一下"
  │
  ▼
QA 启动测试 → 通过/失败
  │
  ├── 通过 → 🔀 @人 "全部通过，可以上线"
  │
  └── 失败 → QA 输出 bug 列表
              │
              ▼
        🔀 @Dev #round=2 "以下 3 个问题需要修复：<list>"
              │
              ▼
        Dev 修复 → 🔀 @QA #round=3 "修好了，重新测"
              │
              ├── 通过 → ✅
              └── 再次失败 → round=4 > maxRoundTrip(3)
                              │
                              ▼
                        @人 "已重试 3 轮仍未通过，请人工介入"
```

### 7.2 Bug 列表结构化

QA 输出的 bug 列表用结构化格式，方便 Dev 理解：

```
🔀 @Dev #round=2
测试未通过，以下是需要修复的 3 个问题：

## Bug 1: 积分计算错误
- 路径: src/points/calculator.ts:45
- 预期: 邀请用户应得 100 分
- 实际: 只得了 50 分
- 复现: 执行测试 test/points.test.ts → testInvitePoints

## Bug 2: 签到页面 UI 错位
- 路径: src/pages/checkin.tsx:120
- 描述: 移动端 375px 宽度下按钮溢出容器

## Bug 3: 并发下积分重复发放
- 路径: src/points/service.ts:88
- 描述: 同一用户快速点击两次签到会发两次积分
- 建议: 加分布式锁
```

---

## 8. 配置扩展

### 8.1 schema.ts 新增

```typescript
interface AgentRoleConfig {
  enabled: boolean;         // 是否启用
  adapter: 'claude' | 'opencode' | string;  // 底层 adapter 类型
  model?: string;           // 模型覆盖
  systemPrompt?: string;    // 角色 system prompt 追加
  maxRoundTrip?: number;    // 最大循环次数
  allowedInChats?: string[]; // 限制在哪些群可用
  permissions?: string[];   // 权限：read, write, exec, admin
}

interface AppPreferences {
  // ... 现有 ...
  agents?: {
    researcher?: AgentRoleConfig;
    pm?: AgentRoleConfig;
    dev?: AgentRoleConfig;
    qa?: AgentRoleConfig;
    growth?: AgentRoleConfig;
  };
  agentRouting?: 'mention' | 'auto' | 'hybrid';
  // mention: 仅通过 @ 触发
  // auto: 自动匹配关键词
  // hybrid: 优先 @，无 @ 时自动匹配
}
```

---

## 9. 飞书群聊交互体验

### 9.1 Agent 消息样式

Agent 发消息统一格式：

```
[🤖 PM Agent] 📋 PRD: 积分系统需求分析
[卡片内容]
---
🔀 @Dev #round=1 技术评估下
```

### 9.2 实时进度卡

开发 agent 执行长任务时，复用现有流式卡片机制：

```
┌─────────────────────────────┐
│ 🤖 Dev Agent · 开发中…      │
│                             │
│ 📁 正在阅读代码库…           │
│ ✅ 已理解现有架构             │
│ ⏳ 正在实现积分服务… (工具调用)│
│    └─ 创建 src/points/       │
│    └─ 写 service.ts          │
│    └─ 写 handler.ts          │
│                             │
│ [⏹ 终止]                    │
└─────────────────────────────┘
```

### 9.3 多 Agent 状态总览

可用 `/agents` 命令查看当前所有 agent 状态：

```
┌─────────────────────────────┐
│ 👥 Agent 状态总览            │
│                             │
│ ✅ 需求挖掘 — 已完成          │
│ ✅ PM — 已完成               │
│ ⏳ Dev — 开发中 (35%)        │
│ ⏸ QA — 等待中               │
│ ⏸ 增长 — 等待中              │
│                             │
│ [📋 查看进度] [🛑 全部停止]   │
└─────────────────────────────┘
```

---

## 10. 改动清单

### 10.1 新增文件

| 文件 | 内容 |
|------|------|
| `src/agent/role.ts` | AgentRole 类型定义 |
| `src/agent/registry.ts` | AgentRegistry 注册表 |
| `src/agent/dispatch.ts` | 调度指令解析 |
| `src/agent/context.ts` | 群聊上下文构建 |

### 10.2 修改文件

| 文件 | 改动 |
|------|------|
| `src/agent/types.ts` | AgentRunOptions 增加 roleId、roundTrip 字段 |
| `src/bot/active-runs.ts` | Map → Map<scope, Map<roleId, RunHandle>> |
| `src/bot/channel.ts` | intakeMessage 增加路由逻辑；runAgentBatch 支持 role-aware；processAgentStream 结束时检查调度 |
| `src/config/schema.ts` | 增加 AgentRoleConfig、agents、agentRouting 类型 |
| `src/config/store.ts` | 读/写 agent 配置 |
| `src/commands/index.ts` | 新增 `/agents` 命令 |
| `src/card/templates.ts` | 新增 agents status card 模板 |
| `src/bot/pending-queue.ts` | scope + roleId 双 key 队列支持 |

### 10.3 不改的文件

| 文件 | 原因 |
|------|------|
| `src/agent/types.ts` (Adapter) | AgentAdapter 接口不变，只扩展 AgentRunOptions |
| `src/agent/claude/adapter.ts` | 复用，只需不同 role 传不同 system prompt |
| `src/agent/opencode/adapter.ts` | 同上 |
| `src/agent/swappable.ts` | 不再需要全局单例切换，由 registry 接管 |
| `src/session/store.ts` | 已经是 `${agentId}:${scope}` key，天然支持多 agent session 隔离 |
| `src/card/run-renderer.ts` | agent 内部渲染不变 |
| `src/card/run-state.ts` | 状态机不感知外部 agent |

---

## 11. 实现计划

### Phase 1: 基础路由 + 单群聊多 Agent（预计 3-5 天）

1. 实现 `AgentRegistry`，注册五个默认角色
2. 改造 `ActiveRuns` 支持 role 维度
3. 在 `intakeMessage` 中识别 `@角色名`，路由到对应 agent
4. 构建群聊上下文注入
5. 验证：用户 @Dev 发消息，Dev 响应

### Phase 2: Agent 自调度（预计 2-3 天）

6. 实现调度指令解析 `parseDispatch()`
7. 在 `processAgentStream` 结束时检查调度
8. 实现 QA→Dev 修复循环
9. 实现轮次计数 + 循环防护

### Phase 3: 体验打磨（预计 2-3 天）

10. 实现 `/agents` 命令和状态卡片
11. Agent 消息样式统一（角色标识）
12. 配置扩展（agent 级别的模型、prompt、访问控制）
13. 自动匹配（无 @ 时关键词路由）

### Phase 4: 可选高级功能

14. PM ↔ 增长对齐阶段并行执行
15. 自定义角色创建（`/agent create`）
16. Agent 输出评审（人在飞书卡片上点 "✅ 通过" 后继续流程）

---

## 12. QA→Dev 修复循环完整时序

```
用户: @Dev 实现积分系统
  │
  ▼
[路由层] → 匹配到 Dev agent
  │
  ▼
Dev agent 启动 → 编码 → 完成
  │
  ▼
Dev 输出末尾: "🔀 @QA #round=1 开发完成，验收一下"
  │
  ▼
[调度器] parseDispatch → 匹配 @QA, round=1
  │
  ▼
[路由层] → 启动 QA agent，传入 round=1
  │
  ▼
QA agent 启动 → 写测试 → 跑测试 → 发现 3 个 bug
  │
  ▼
QA 输出末尾: "🔀 @Dev #round=2 以下 3 个问题需要修复..."
  │
  ▼
[调度器] → round=2 ≤ 3 → 继续
  │
  ▼
Dev agent 启动 → 修复 → 完成
  │
  ▼
Dev 输出末尾: "🔀 @QA #round=3 修好了，重新测"
  │
  ▼
QA agent 启动 → 回归测试 → 全部通过 ✅
  │
  ▼
QA 输出末尾: "🔀 @用户 #round=1 全部测试通过，可以上线"
  │
  ▼
[调度器] → @用户 不是已注册 agent → 转发给人 (群聊消息正常发出)
```

**循环防护生效条件：**
- round > 3 → 终止循环，@人介入
- agent 异常退出（非 done 状态）→ 不触发调度
- agent 超时 → 不触发调度
- 人中途发消息打断 → 清除当前活跃 run，重置调度
