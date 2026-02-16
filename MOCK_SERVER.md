bun/typescript, 之用一个 文件设计出一个测试mock服务器，模拟一个带并发限制和 rate limit 限制的服务器，用于测试之用，支持一下特性：
1. 支持用一个函数接受配置启动服务器，包括端口，以及“模拟服务”单向或者多项目配置
2. 支持对启动的mock服务器调用一个 api 就让服务器自动关掉并退出
3. 提供一个 api endpoint 创建和销毁一个“模拟服务”（接受一个path）,POST BODY 包括：最大并发数设置，rate limit 设置。 例如   POST /service/:service_name；  DELETE /service/:service_name;
4. 提供对已经创建的“模拟服务”进行访问，服务器会对模拟服务执行并发和限流规则，并按照常规实践进行 HTTP status 状态抛出异常。这个服务如果正常返回，最好有一个随机 ID 返回代表这个请求的唯一表示，以及 meta 信息 包括rt run time，ts timestamp
总之，就是给 tem 或其他客户端提供 api 模拟测试服务器的功能
基于以上需求帮我设计一个程序 PRD，我会用这个 PRD 去让 CC 实现。有不清楚的地方可以反问我


==========

很好，这个需求是清晰的，而且是一个**偏基础设施测试工具**，不是业务逻辑系统。PRD 要写得足够工程化，否则实现的人会边做边猜。

下面是我为你整理的 **可直接交给 CC 实现的 PRD v1.0**。
结构包括：目标、架构、API 设计、数据模型、并发模型、限流算法、生命周期管理、错误码约定、实现约束。

---

# Mock Test Server PRD

（Bun + TypeScript 单文件实现）

---

# 一、产品目标

设计一个 **单文件 Mock HTTP Server（Bun + TypeScript）**，用于：

* 模拟带 **最大并发限制**
* 模拟带 **Rate Limit 限流**
* 支持动态创建和销毁“模拟服务”
* 支持通过 API 关闭整个服务器
* 用于压测、客户端限流策略测试、异常恢复测试等场景

⚠️ 注意：

* 这是测试工具，不是生产服务器
* 不需要持久化
* 不需要数据库
* 不需要鉴权（除非后续扩展）

---

# 二、整体架构设计

### 单文件结构建议

```
mock-server.ts
```

### 核心组件（逻辑分层）

1. Server Bootstrap（启动器）
2. Service Manager（服务注册与管理）
3. Rate Limiter（限流器）
4. Concurrency Controller（并发控制器）
5. HTTP Router
6. Shutdown Controller

---

# 三、启动方式

## 1️⃣ 启动函数

提供一个函数：

```ts
startMockServer(config: ServerConfig): void
```

### ServerConfig

```ts
interface ServerConfig {
  port: number;
  mode?: "single" | "multi";
  defaultService?: ServiceConfig; // mode=single 时使用
}
```

### 运行模式说明

#### 模式 A：single

* 启动时自动创建一个默认服务
* 所有请求默认命中该服务
* 不允许创建多服务（调用创建接口会返回 400）

#### 模式 B：multi（默认）

* 支持动态创建多个 service
* 访问路径为 `/mock/:service_name`

---

# 四、API 设计

---

## 1️⃣ 创建服务

```
POST /service/:service_name
```

### Request Body

```json
{
  "maxConcurrency": 5,
  "rateLimit": {
    "limit": 10,
    "windowMs": 1000
  },
  "minDelayMs": 10,
  "maxDelayMs": 200
}
```

### 字段说明

| 字段                 | 说明       |
| ------------------ | -------- |
| maxConcurrency     | 最大并发数    |
| rateLimit.limit    | 窗口内最大请求数 |
| rateLimit.windowMs | 限流窗口时间   |
| minDelayMs         | 最小模拟响应时间 |
| maxDelayMs         | 最大模拟响应时间 |

### 返回

```json
{
  "service": "abc",
  "status": "created"
}
```

---

## 2️⃣ 删除服务

```
DELETE /service/:service_name
```

返回：

```json
{
  "service": "abc",
  "status": "deleted"
}
```

---

## 3️⃣ 访问模拟服务

### multi 模式

```
GET /mock/:service_name
```

### single 模式

```
GET /
```

---

### 成功返回示例

```json
{
  "requestId": "uuid-or-random-id",
  "meta": {
    "ts": 1710000000000,
    "rt": 132
  },
  "data": "ok"
}
```

字段说明：

| 字段        | 含义       |
| --------- | -------- |
| requestId | 随机唯一 ID  |
| meta.ts   | 时间戳      |
| meta.rt   | 响应耗时（毫秒） |

---

# 五、并发控制设计

每个 Service 独立维护：

```ts
currentConcurrency: number
maxConcurrency: number
```

请求进入时：

```
if currentConcurrency >= maxConcurrency
   return 503
else
   currentConcurrency++
```

请求结束后：

```
currentConcurrency--
```

---

## 并发超限返回

HTTP 503

```json
{
  "error": "concurrency_limit_exceeded"
}
```

---

# 六、Rate Limit 设计

采用滑动窗口（简化版本）：

```ts
timestamps: number[]
```

每次请求：

1. 清理 window 外的 timestamp
2. 如果 length >= limit → 429
3. 否则 push 当前时间

---

## 限流返回

HTTP 429

```json
{
  "error": "rate_limit_exceeded"
}
```

---

# 七、模拟延迟逻辑

每个请求：

```
delay = random(minDelayMs, maxDelayMs)
await sleep(delay)
```

响应时记录：

```
rt = Date.now() - start
```

---

# 八、关闭服务器 API

```
POST /shutdown
```

返回：

```json
{
  "status": "shutting_down"
}
```

逻辑：

1. 返回响应
2. setTimeout(100ms)
3. server.stop()
4. process.exit(0)

---

# 九、错误处理约定

| 情况             | 状态码 |
| -------------- | --- |
| 服务不存在          | 404 |
| 并发超限           | 503 |
| rate limit 超限  | 429 |
| 非法参数           | 400 |
| single 模式下创建服务 | 400 |

---

# 十、内部数据结构

```ts
interface Service {
  name: string;
  maxConcurrency: number;
  currentConcurrency: number;
  rateLimit: {
    limit: number;
    windowMs: number;
    timestamps: number[];
  };
  minDelayMs: number;
  maxDelayMs: number;
}
```

```ts
const services: Map<string, Service>
```

---

# 十一、线程模型说明（Bun）

* 单线程事件循环
* 并发为异步 IO 并发
* 不涉及 worker thread
* 不需要锁

---

# 十二、日志建议（可选）

建议输出：

```
[INFO] Service created
[INFO] Service deleted
[WARN] Rate limit exceeded
[WARN] Concurrency exceeded
```

---

# 十三、非目标（明确不做）

* 不做持久化
* 不做鉴权
* 不做集群
* 不做分布式限流
* 不做 UI

---

# 十四、示例使用流程

### 启动

```ts
startMockServer({
  port: 3000,
  mode: "multi"
})
```

### 创建服务

```
POST /service/payment
```

### 压测

```
GET /mock/payment
```

### 关闭

```
POST /shutdown
```

---

# 十五、扩展建议（可选）

未来可以扩展：

* 按 IP 限流
* 动态修改配置
* 模拟错误概率
* 模拟超时
* 支持 POST body 回显
* 支持返回自定义 HTTP 状态

---

# 十六、你需要确认的 3 个问题

我需要你明确以下三点，否则实现会产生歧义：

1. Rate limit 是全局 per service 还是 per client IP？
2. 是否需要支持 HTTP 方法区分（GET / POST）？
3. 是否需要支持返回自定义响应内容？

---

如果你愿意，我可以下一步帮你：

* 给你一个“更工程化版本”的 PRD（带状态机和流程图）
* 或直接给你一个 300 行以内的 Bun 单文件实现示例
* 或帮你设计一个适合团队复用的 Mock Framework 版本

你这个方向是对的。
一个好的 mock infra 能节省你很多测试成本。
