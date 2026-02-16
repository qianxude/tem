现在我想写一个typescript/bun +bun:sqlite 技术栈绑定的任务执行管理框架叫做 tem (task execution management) framework, 内置之前我们讨论过的泛化后的任务批次，任务状态，以及任务数据等数据表结构。通过对任务管理的对象抽象，对象持久化和查询，设计一套任务计划（添加批次，添加任务）和任务执行（可与任务计划同进程，也可以将worker 放在不同集成里，每个 worker 支持设置任务并发执行数，以及时间窗口内限频等功能）。帮我设计一套 API 接口，我会和你讨论，最终定稿
===============
很好，这个方向是对的。你不是在写“一个批处理脚本”，你是在做一个**可复用的执行引擎内核**。如果设计好，以后所有异步任务都可以往里塞。

我会给你一套**清晰分层、进程友好、SQLite 友好、可扩展**的 API 设计。重点是：

* 任务计划层（Planning）
* 调度层（Scheduler / Dispatcher）
* Worker 执行层
* 状态一致性模型（乐观锁 + claim 机制）
* 并发与限频控制
* 跨进程安全

我们一步步来。

---


# 一、核心设计原则（你先确认是否认可）

### 1️⃣ SQLite 不是问题，但你必须接受：

* 多进程可以同时打开同一个 sqlite 文件
* 但同一时刻只有一个 writer
* 必须使用 WAL 模式
* 必须使用「任务 claim」而不是“直接更新状态执行”

### 2️⃣ Worker 绝对不能直接：

```ts
UPDATE task SET status='running' WHERE status='pending'
```

而必须：

```ts
UPDATE task
SET status='running', worker_id=?, claimed_at=?, version=version+1
WHERE id=? AND status='pending' AND version=?
```

否则你做再多乐观锁都没用。

### 3️⃣ 不做 DB 锁驱动调度

不要依赖 sqlite 锁作为调度机制。
DB 只做状态持久化，不做执行控制。

---

# 二、整体架构

```
TEM
 ├─ TaskStore (sqlite persistence)
 ├─ Planner (添加批次/任务)
 ├─ Dispatcher (claim 任务)
 ├─ Worker (执行任务)
 ├─ RateLimiter
 └─ ConcurrencyController
```

---

# 三、核心 API 设计（第一版）

我用 typescript 接口形式写。

---

# 1️⃣ TEM 初始化

```ts
const tem = new TEM({
  dbPath: "./tem.db",
  wal: true,
  busyTimeout: 5000
})
```

内部：

* 开启 WAL
* 设置 busy_timeout
* 自动建表
* 初始化索引

---

# 2️⃣ 批次 API（Batch Planning）

```ts
const batch = await tem.batch.create({
  type: "import-users",
  metadata: { source: "s3://xxx.csv" },
})
```

接口设计：

```ts
interface BatchAPI {
  create(input: {
    type: string
    metadata?: Record<string, any>
  }): Promise<Batch>

  get(id: string): Promise<Batch>

  list(filter?: {
    status?: BatchStatus
    type?: string
  }): Promise<Batch[]>

  cancel(id: string): Promise<void>
}
```

---

# 3️⃣ 任务计划 API（添加任务）

```ts
await tem.task.enqueue({
  batchId: batch.id,
  type: "process-user",
  payload: { userId: 123 }
})
```

批量添加：

```ts
await tem.task.enqueueMany([
  ...
])
```

接口：

```ts
interface TaskAPI {
  enqueue(input: TaskInput): Promise<Task>
  enqueueMany(input: TaskInput[]): Promise<void>

  get(id: string): Promise<Task>

  list(filter?: TaskFilter): Promise<Task[]>
}
```

---

# 4️⃣ Worker API（执行层）

这个是关键。

Worker 是可以独立进程运行的。

```ts
const worker = tem.createWorker({
  name: "worker-1",
  concurrency: 5,
  rateLimit: {
    max: 100,
    duration: 60_000
  },
  pollInterval: 1000
})

worker.register("process-user", async (task) => {
  ...
})

worker.start()
```

接口设计：

```ts
interface WorkerOptions {
  name: string
  concurrency: number
  rateLimit?: {
    max: number
    duration: number
  }
  pollInterval?: number
  taskTypes?: string[]
}

interface Worker {
  register(type: string, handler: TaskHandler): void
  start(): void
  stop(): Promise<void>
}
```

---

# 5️⃣ 任务 Claim API（调度核心）

Worker 内部会周期性：

```ts
await tem.dispatcher.claimTasks({
  workerId,
  limit: concurrency - runningCount,
  taskTypes
})
```

返回：

```ts
Task[]
```

内部 SQL 必须是：

```sql
UPDATE task
SET status='running',
    worker_id=?,
    claimed_at=?
WHERE id IN (
  SELECT id FROM task
  WHERE status='pending'
  ORDER BY priority DESC, created_at
  LIMIT ?
)
RETURNING *
```

⚠ 如果 SQLite 版本不支持 returning，就两步走 + version 乐观锁。

---

# 6️⃣ 任务状态更新 API（强一致写）

```ts
await tem.task.complete(task.id, {
  result: {...}
})

await tem.task.fail(task.id, {
  error: "timeout",
  retryable: true
})
```

内部必须：

```sql
UPDATE task
SET status='completed',
    version=version+1
WHERE id=? AND version=?
```

更新失败 = 说明任务已被抢占或超时回收。

---

# 7️⃣ 心跳 + 超时回收（防止 worker crash）

Worker 每 10 秒：

```ts
tem.worker.heartbeat(workerId)
```

系统有一个回收机制：

```ts
tem.dispatcher.recoverStalledTasks({
  timeout: 300000
})
```

把：

```
running + claimed_at < now - timeout
```

改回 pending。

---

# 四、并发与限频模型设计

### 1️⃣ 并发控制（进程内）

简单 semaphore 即可：

```ts
class ConcurrencyController {
  acquire()
  release()
}
```

---

### 2️⃣ 全局限频（跨进程）

SQLite 表：

```
rate_limit_bucket
  key
  tokens
  last_refill
```

Worker claim 前尝试消耗 token。

用事务保证一致性。

---

# 五、跨进程模型

每个 worker：

```
bun worker.ts
```

它只需要：

```ts
new TEM({ dbPath })
```

不共享内存。

竞争依靠：

* claim UPDATE
* 乐观锁 version
* busy_timeout

---

# 六、最终 API 总览（完整草案）

```ts
const tem = new TEM(config)

/* Planning */
tem.batch.create()
tem.task.enqueue()

/* Execution */
const worker = tem.createWorker(options)
worker.register()
worker.start()

/* Dispatch */
tem.dispatcher.claimTasks()
tem.dispatcher.recoverStalledTasks()

/* Task state */
tem.task.complete()
tem.task.fail()
tem.task.retry()
```

---

# 七、关键问题我反问你

1. 你希望 worker 只拉任务，还是支持 push 模式？
2. 你是否需要任务依赖 DAG？
3. 任务是否需要延迟执行（delay / scheduled_at）？
4. 是否需要优先级？
5. 是否要支持“唯一任务去重”？

这五个决定框架复杂度。

---

# 八、我的建议（直说）

第一版不要做 DAG。
不要做复杂分布式限频。
不要做 push 模式。

先把：

* 跨进程安全
* 乐观锁
* claim 模型
* 心跳 + 回收
* 并发 + 基础限频

做稳定。

等你验证真实 workload，再扩。

---

如果你愿意，我们下一步可以：

* 把数据库 schema 彻底设计成 v1.0
* 或者开始把 Worker 内部执行循环设计成 state machine

你想从哪块开始深挖？


=====================

1. 算了，不支持跨进程worker cluster 了，task 主要是做 llm 调用，属于 io-bounded task，先不做这么复杂了，以后 CPU-bounded task 才需要多进程 worker。
2. 讲解一下 claim api 是啥意思？不太懂
3. 任务执行过程中有可能很多task retry 多次后直接设置成 failed 状态，然后整个任务执行完后，希望有一个断点回复和失败任务在集中重试一遍的功能（如果把一些问题修复后，可能整体任务批次重试的时候就都过了）。
4. 之前谈到的  record 记录表也不需要了，所有任务相关的数据全都放在 payload Json 字段里，也没有需求再去拆卸你这个字段，任务执行的时候任务处理函数自己回被传入这个对象，自己解读业务数据含义。
5. 任务批次对象有明确的code 编码字段，需要每次设置，一般用户给以个时间标签，用来标记同类任务多个批次执行的区别。
根据这些反馈重新设计

====================
很好，这次你开始收敛了 👍
不做跨进程 cluster，复杂度立刻下降一大截。现在我们可以做一个**干净、可控、专注 IO 任务**的 v1 框架。

我重新给你设计一套「单进程 + SQLite + IO-bound LLM 任务」版本。

并重点讲清楚你问的 claim 是什么。

---

# 一、先讲清楚：Claim API 是什么？

你之前不理解，很正常。

### ❓为什么需要 claim？

假设数据库里：

```
task1  pending
task2  pending
task3  pending
```

Worker 轮询时：

1. 查 pending 任务
2. 选 5 个
3. 执行

如果你只做：

```ts
SELECT * FROM task WHERE status='pending'
```

然后在代码里：

```ts
task.status = 'running'
```

⚠ 问题是：

* 如果 future 你加了另一个 worker
* 或者你一个 worker 并发 10 个 async

可能同一个 task 被执行两次。

---

## ✅ Claim 的本质

Claim = **原子抢占任务**

意思是：

> “我要把这条任务标记为 running，如果且仅如果它现在还是 pending”

SQL 形式：

```sql
UPDATE task
SET status='running',
    claimed_at=?,
    version=version+1
WHERE id=? AND status='pending'
```

如果 update 行数 = 1
说明你成功抢到任务

如果 = 0
说明已经被抢了 / 状态变了

---

## 但你现在是单进程

即便如此，我仍然建议保留 claim 模型。

因为：

* future 扩展安全
* 并发 async 任务安全
* retry 重试时不会误抢

你可以把 claim 理解为：

> 从 pending → running 的“原子状态跃迁”

---

# 二、根据你现在的简化需求，重新设计 v1

你现在的约束：

* 单进程
* IO-bound
* 不做 record 表
* payload 全 JSON
* 支持 retry
* 支持批次断点恢复
* 支持批次整体失败重试
* 批次必须有 code 字段（人为标签）

很好。那我们做一个**简洁强壮版 TEM v1**

---

# 三、数据库结构（v1 最优简化版）

## batch 表

```sql
batch
------
id TEXT PK
code TEXT NOT NULL   -- 用户提供的时间标签
type TEXT NOT NULL
status TEXT          -- running / completed / failed
created_at INTEGER
completed_at INTEGER
metadata JSON
```

---

## task 表

```sql
task
------
id TEXT PK
batch_id TEXT
type TEXT
status TEXT          -- pending / running / completed / failed
payload JSON
result JSON
error TEXT

attempt INTEGER DEFAULT 0
max_attempt INTEGER DEFAULT 3

claimed_at INTEGER
completed_at INTEGER

version INTEGER DEFAULT 0
created_at INTEGER
```

没有 record 表。
所有业务数据都在 payload。

很好。干净。

---

# 四、API 重新设计（完全贴合你当前需求）

---

# 1️⃣ 初始化

```ts
const tem = new TEM({
  dbPath: "./tem.db",
  concurrency: 10,
  pollInterval: 1000
})
```

这里 concurrency 是全局 worker 并发。

---

# 2️⃣ 批次 API

```ts
const batch = await tem.batch.create({
  code: "2026-02-15-llm-fix",
  type: "rewrite-docs"
})
```

接口：

```ts
tem.batch.create()
tem.batch.get()
tem.batch.list()
tem.batch.retryFailed(batchId)
tem.batch.resume(batchId)
```

---

# 3️⃣ 添加任务

```ts
await tem.task.enqueue({
  batchId: batch.id,
  type: "rewrite",
  payload: {...},
  maxAttempt: 5
})
```

批量：

```ts
await tem.task.enqueueMany([...])
```

---

# 4️⃣ Worker 注册

单进程版本：

```ts
tem.worker.register("rewrite", async (task) => {
  const { payload } = task

  const result = await callLLM(payload)

  return result
})
```

然后：

```ts
tem.worker.start()
```

---

# 五、执行循环（内部逻辑）

Worker 内部逻辑：

```
while (running) {
   if (runningCount < concurrency) {
       claimOneTask()
       run(task)
   }
   sleep(pollInterval)
}
```

---

# 六、任务执行流程（完整状态流）

```
pending
  ↓ claim
running
  ↓ success
completed

running
  ↓ error + attempt < max
pending

running
  ↓ error + attempt >= max
failed
```

---

# 七、重试与断点恢复设计

你这个需求是关键，我认真设计。

---

## 1️⃣ 单任务 retry 机制（自动）

执行失败：

```ts
if (task.attempt + 1 < maxAttempt) {
   UPDATE task
   SET status='pending',
       attempt=attempt+1
}
else {
   UPDATE task
   SET status='failed'
}
```

---

## 2️⃣ 批次断点恢复

你想要：

> 修复问题后，批次可以重新跑失败任务

API：

```ts
await tem.batch.retryFailed(batchId)
```

实现：

```sql
UPDATE task
SET status='pending',
    attempt=0
WHERE batch_id=? AND status='failed'
```

---

## 3️⃣ 批次 resume

如果执行中断（比如程序 crash）

恢复：

```ts
await tem.batch.resume(batchId)
```

做：

```sql
UPDATE task
SET status='pending'
WHERE batch_id=? AND status='running'
```

这叫：

> running 回滚

---

# 八、批次状态自动计算

不存 batch.status 也可以。

实时计算：

```
if exists pending or running → running
if all completed → completed
if some failed → failed
```

或者做一个 finalizeBatch(batchId)。

---

# 九、最终 API 总览（v1 极简但完整）

```ts
const tem = new TEM(config)

/* Batch */
tem.batch.create()
tem.batch.resume()
tem.batch.retryFailed()

/* Task */
tem.task.enqueue()
tem.task.enqueueMany()

/* Worker */
tem.worker.register()
tem.worker.start()
tem.worker.stop()
```

---

# 十、你现在这个架构的优点

✔ 简单
✔ 单进程 IO-bound 性能足够
✔ 支持断点
✔ 支持集中重试
✔ 不拆 payload
✔ 批次可区分 code

---

# 十一、我给你的真实建议（直接说）

现在千万别：

* 上多进程
* 上复杂限频
* 上分布式
* 上 DAG

先把：

* LLM 调用稳定
* retry 逻辑可靠
* 错误可观测
* 批次可恢复

跑 1~2 周真实 workload。

再考虑扩展。

---

# 十二、下一步你可以选

1. 我们把 Worker 内部调度循环写成正式 state machine
2. 设计一个干净的 Typescript interface 定稿
3. 设计 SQLite 索引优化（保证 10w 任务也流畅）
4. 设计错误分类系统（retryable vs fatal）

你选一个，我们深入打磨。

==============
1. 根据你的设计，我是不是可以直接原生代码支持多任务并发控制了，不需要 p-limit p-queue 这类第三方并发控制依赖了？
2. 每分钟内对 LLM provider 的 api call 有 limit上线，前面你的设计里支持这个吗？逻辑好实现吗？


==============
问得很好。这两个问题决定你这个框架会不会“稳”。

我直接给你结论，然后讲清楚原理。

---

# 1️⃣ 并发控制：还需要 p-limit / p-queue 吗？

## 结论

**不需要。你完全可以自己原生实现，而且更可控。**

原因很简单：

你现在是：

* 单进程
* IO-bound（LLM 调用）
* 明确知道最大并发数

你只需要一个最基础的 semaphore。

---

## 最简单的并发控制模型

核心逻辑：

```ts
while (running) {
  while (runningCount < concurrency) {
    const task = claimOne()
    if (!task) break
    execute(task)
  }
  sleep(pollInterval)
}
```

execute 内部：

```ts
runningCount++

try {
  await handler(task)
} finally {
  runningCount--
}
```

这就够了。

---

## 为什么我不建议你上 p-limit？

因为：

* 你不是在控制一堆函数
* 你是在控制一个“调度循环”
* 你还要和数据库 claim 结合
* 还要处理 retry / 状态迁移

p-limit 解决的是：

> “限制某堆 promise 并发”

而你是：

> “一个持续运行的任务调度器”

概念层级不一样。

---

## 什么时候才需要 p-queue？

如果你有：

* 优先级队列
* 多类任务
* 动态插入外部 promise
* 延迟执行

你现在还没到那一步。

---

# 2️⃣ 每分钟 LLM API limit 怎么办？

这才是关键问题。

你说：

> 每分钟 X 次

这是**速率限制（Rate Limit）**
不是并发控制。

---

## 并发 vs 速率是两回事

| 控制类型 | 控制什么       |
| ---- | ---------- |
| 并发   | 同时执行多少个    |
| 速率   | 单位时间内最多多少次 |

---

# 你的设计支持吗？

我之前给你的 v1 版本 **还没加速率限制模块**。

但很好加。

而且实现难度低。

---

# 最简单可靠方案（推荐）

## 滑动时间窗口计数器

维护：

```ts
let callTimestamps: number[] = []
```

每次调用前：

```ts
const now = Date.now()

// 清理 60 秒前的记录
callTimestamps = callTimestamps.filter(t => now - t < 60000)

if (callTimestamps.length >= MAX_PER_MINUTE) {
   wait until earliest timestamp + 60000
}

callTimestamps.push(now)
```

---

## 这够用吗？

对于单进程：

✔ 完全够用
✔ 不需要 Redis
✔ 不需要 token bucket
✔ 不需要复杂算法

---

# 更优雅一点：Token Bucket

如果你想专业一点：

```ts
class RateLimiter {
  tokens: number
  lastRefill: number

  async acquire() {
     refill()
     if (tokens > 0) {
        tokens--
        return
     }
     await sleep(...)
     return acquire()
  }
}
```

每秒补充：

```
max_per_minute / 60
```

---

# 并发 + 速率怎么组合？

正确顺序：

```
1. concurrency permit
2. rateLimiter.acquire()
3. call LLM
```

千万别反过来。

否则你会：

* 抢到速率
* 但排队等待并发
* 结果浪费速率 token

---

# 一个真实问题你要考虑

LLM provider 通常有：

* 每分钟 limit
* 每秒 limit
* 并发连接数 limit

所以你应该设计成：

```ts
new TEM({
  concurrency: 10,
  rateLimit: {
     perMinute: 60,
     perSecond: 5
  }
})
```

然后：

```
await rateLimiter.acquire()
```

---

# 重要提醒（你别忽略）

LLM 调用失败可能是：

* 429 rate limit
* 5xx
* 网络错误

你应该：

* 把 429 当 retryable
* 并且触发延迟 retry（比如 2 秒）

否则你会：

> 一堆任务同时 retry → 再次打爆 provider

---

# 现实建议

你现在这个规模：

* 单进程
* 并发 5~20
* 每分钟 60~300 次

一个简单内存 rate limiter 完全够用。

等你规模 10x 再升级。

---

# 总结

### Q1：需要 p-limit 吗？

不需要。你自己实现更干净。

### Q2：支持 rate limit 吗？

可以，非常好实现。
建议做一个内置 RateLimiter 类。

---

# 下一步我建议

我们可以设计一个：

```
ExecutionController
 ├─ ConcurrencyController
 ├─ RateLimiter
 └─ RetryStrategy
```

把执行模型彻底抽象干净。

要不要我们把这块正式定稿成框架核心？
======================

现在越来越清晰了，请将砸门总计的需求以及设计总结成一个 claude code 的 tem 开发计划，可以是一个 task ,也可以是多个task 给我，我要让 CC 帮我完成。是否需要安装一些这个产品所需的 skill,也告诉我。

======================



很好。现在确实到了“可以交给 Claude Code 落地”的阶段。

我给你一个**结构化的 TEM v1 开发计划**，是可以直接喂给 Claude Code 执行的任务拆分说明。
不会模糊，不会泛泛而谈，是真正能生成可运行代码的那种。

我分成：

1. 产品目标定义
2. 技术约束
3. 架构设计定稿
4. 数据库 Schema
5. 模块拆分
6. Claude Code 任务拆分（可以直接喂）
7. 需要的技能 / 依赖

---

# 一、TEM v1 产品目标

TEM = Task Execution Management Framework

目标：

* 单进程
* IO-bound（LLM 调用）
* SQLite 持久化
* 批次管理
* 自动 retry
* 批次断点恢复
* 批次失败集中重试
* 并发控制
* LLM 速率限制
* 不做跨进程
* 不做 DAG
* 不拆 payload JSON

这是一个“可嵌入型执行内核”。

---

# 二、技术约束

* Runtime: Bun
* DB: bun:sqlite
* 单进程
* 不依赖 Redis
* 不依赖第三方 queue 库
* 不依赖 p-limit / p-queue

---

# 三、系统架构定稿

```
TEM
 ├── DatabaseLayer
 ├── BatchService
 ├── TaskService
 ├── Dispatcher
 ├── Worker
 ├── ConcurrencyController
 ├── RateLimiter
 └── RetryStrategy
```

Worker 是核心执行循环。

---

# 四、数据库 Schema（定稿）

## batch

```sql
CREATE TABLE batch (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  metadata TEXT
);
```

不存 batch.status，动态计算。

---

## task

```sql
CREATE TABLE task (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  type TEXT NOT NULL,

  status TEXT NOT NULL, -- pending | running | completed | failed

  payload TEXT NOT NULL,
  result TEXT,
  error TEXT,

  attempt INTEGER DEFAULT 0,
  max_attempt INTEGER DEFAULT 3,

  claimed_at INTEGER,
  completed_at INTEGER,

  version INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

---

## 索引

```sql
CREATE INDEX idx_task_batch ON task(batch_id);
CREATE INDEX idx_task_status ON task(status);
CREATE INDEX idx_task_claimed ON task(claimed_at);
```

---

# 五、模块职责说明

## 1️⃣ DatabaseLayer

* 初始化数据库
* 执行 SQL
* 事务封装

---

## 2️⃣ BatchService

API:

```
create()
get()
list()
resume(batchId)
retryFailed(batchId)
getStats(batchId)
```

---

## 3️⃣ TaskService

API:

```
enqueue()
enqueueMany()
complete()
fail()
claimOne()
```

claimOne 是关键。

---

## 4️⃣ Worker

负责：

* 调度循环
* 并发控制
* 速率限制
* 状态迁移
* 调用 handler

---

## 5️⃣ ConcurrencyController

简单 semaphore。

---

## 6️⃣ RateLimiter

支持：

```
perMinute
perSecond
```

内存 token bucket。

---

## 7️⃣ RetryStrategy

默认：

```
if attempt < maxAttempt → retry
else → failed
```

支持可扩展。

---

# 六、Claude Code 开发任务拆分

你可以让 Claude Code 按以下顺序实现。

---

# TASK 1：项目初始化

> 创建一个 Bun + TypeScript 项目，目录结构如下：

```
/tem
  /src
    tem.ts
    db.ts
    batch.ts
    task.ts
    worker.ts
    dispatcher.ts
    concurrency.ts
    rateLimiter.ts
    retry.ts
  index.ts
```

要求：

* ESM
* strict mode
* no implicit any

---

# TASK 2：实现数据库层

要求：

* 初始化 SQLite
* 自动建表
* WAL 模式
* busy_timeout 设置

---

# TASK 3：实现 BatchService

实现：

* create
* resume
* retryFailed
* getStats（统计 completed / failed / pending 数量）

---

# TASK 4：实现 TaskService

实现：

* enqueue
* enqueueMany（事务）
* claimOne（原子状态更新）
* complete
* fail

claimOne 必须：

* status='pending'
* 更新为 running
* 设置 claimed_at
* version++

---

# TASK 5：实现 ConcurrencyController

实现：

```
acquire()
release()
getRunningCount()
```

---

# TASK 6：实现 RateLimiter

支持：

```
perMinute
perSecond
```

使用 token bucket。

API:

```
await rateLimiter.acquire()
```

---

# TASK 7：实现 Worker

Worker 需要：

* register(type, handler)
* start()
* stop()

内部逻辑：

```
while (running) {
   while (runningCount < concurrency) {
       const task = claimOne()
       if (!task) break
       execute(task)
   }
   sleep(pollInterval)
}
```

execute 流程：

```
acquire concurrency
acquire rate limit
call handler
success → complete
error → fail or retry
release concurrency
```

---

# TASK 8：实现批次断点恢复

resume(batchId):

```
running → pending
```

---

# TASK 9：实现批次失败集中重试

retryFailed(batchId):

```
failed → pending
attempt=0
```

---

# TASK 10：写一个示例 LLM handler

模拟：

```
随机成功 / 随机失败
```

验证：

* retry
* rate limit
* 并发
* 批次恢复

---

# 七、Claude Code 需要的技能

Claude Code 不需要特别插件。

但建议：

### 必须

* TypeScript
* SQLite
* Bun runtime

---

### 推荐（非必须）

* 单元测试（vitest）
* logging（pino）

---

# 八、最终交付标准

Claude Code 完成后，你应该能：

```ts
const tem = new TEM({
  dbPath: "./tem.db",
  concurrency: 5,
  rateLimit: {
    perMinute: 60
  }
})

const batch = await tem.batch.create({
  code: "2026-02-15-llm-test",
  type: "rewrite"
})

await tem.task.enqueueMany([...])

tem.worker.register("rewrite", async (task) => {
   return callLLM(task.payload)
})

tem.worker.start()
```

然后：

* 程序中断
* 重启
* resume(batchId)
* 继续跑

---

# 九、现实建议（重要）

不要一次性让 Claude Code 写完。

顺序执行 TASK 1 → TASK 4
你 review
再继续 TASK 5 → TASK 7

否则会出现：

* 代码结构跑偏
* 状态机混乱
* 过度抽象

---

# 十、下一步建议

如果你愿意，我可以：

* 帮你写一份「Claude Code 专用系统提示」
* 或者帮你压缩成一个可直接粘贴的完整开发指令
* 或者帮你再精简成 MVP 版本

你想要哪种？
