# Knowledge Service(知识库服务)

[English](README.md) | 中文

独立部署的企业级知识库服务,提供文档摄取、ACL 感知检索、混合召回、重排、答案生成、引用定位、评估与运维指标。

本仓库可独立部署,无需运行在 Octopus monorepo 之内。

## 功能

- 文档空间、上传、版本管理、摄取任务与重建索引任务
- 基于 MinerU 的文档解析,处理 PDF 与版面复杂的文档
- Parser 适配层,含 mock 与 MinerU HTTP 两种实现
- Embedding 适配层,含 mock 与 BGE-M3(经 Ollama)两种实现
- 向量检索,含 in-memory 与 Qdrant HTTP 适配器
- 全文检索,含 in-memory BM25 与 Elasticsearch 适配边界
- Rerank 适配层,含 mock 与 TEI 兼容的重排实现
- OpenAI 兼容的 LLM 答案生成
- 租户/来源维度的 ACL 过滤与引用锚点
- Prisma/MySQL 持久化,本地开发可用 in-memory 存储
- Prometheus 指标与 SSE 任务进度事件

## 仓库结构

- `services/knowledge`:HTTP API、运行时装配、摄取 worker、检索、答案生成、仓储层与测试。
- `packages/knowledge-contracts`:共享的请求签名、鉴权头、上下文、id、状态与错误契约。
- `services/knowledge/prisma`:独立的 Prisma schema 与 migration。

## 环境要求

- Node.js 22 或更高
- pnpm 9 或更高
- 可选:MySQL 8+ 用于持久化存储
- 可选:Qdrant、Ollama、TEI、MinerU、OpenAI 兼容 LLM 端点,用于生产适配器

## 快速开始

```bash
pnpm install
cp services/knowledge/.env.example services/knowledge/.env
pnpm dev
```

服务监听 `KNOWLEDGE_SERVICE_PORT`,默认 `8080`。

未设置 `KNOWLEDGE_DATABASE_URL` 时,服务使用 in-memory 存储。这适合本地开发与 API 冒烟测试,但进程退出后数据即丢失。

## 生产部署

至少设置:

```bash
KNOWLEDGE_SERVICE_PORT=8080
KNOWLEDGE_SERVICE_TOKEN=replace-with-a-strong-token
KNOWLEDGE_SOURCE_SYSTEM_ID=knowledge
KNOWLEDGE_DATABASE_URL=mysql://user:password@host:3306/knowledge
PARSER_PROVIDER=mineru
MINERU_HTTP_ENDPOINT=http://mineru:8000
MINERU_AUTH_TOKEN=replace-if-your-mineru-service-requires-auth
```

然后执行:

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:migrate
pnpm build
pnpm start
```

## Docker

```bash
docker build -t knowledge-service .
docker run --rm -p 8080:8080 --env-file services/knowledge/.env knowledge-service
```

使用 MySQL 时,启动容器前先跑迁移:

```bash
pnpm prisma:migrate
```

## MinerU 文档解析

设置 `PARSER_PROVIDER=mineru` 启用 MinerU 解析。此模式下,PDF 与版面复杂的文档经 `MinerUHttpAdapter` 路由给 MinerU,纯文本类文件交给轻量文本解析器兜底。

```bash
PARSER_PROVIDER=mineru
MINERU_HTTP_ENDPOINT=http://mineru:8000
MINERU_AUTH_TOKEN=optional-token
MINERU_TIMEOUT_MS=120000
```

## 适配器环境变量

- `EMBEDDING_PROVIDER=mock | bge-m3-ollama`
- `OLLAMA_ENDPOINT`、`OLLAMA_EMBED_MODEL`、`OLLAMA_TIMEOUT_MS`
- `VECTOR_PROVIDER=in-memory | qdrant-http`
- `QDRANT_ENDPOINT`、`QDRANT_COLLECTION`、`QDRANT_API_KEY`
- `FULLTEXT_PROVIDER=in-memory | elasticsearch`
- `ELASTICSEARCH_ENDPOINT`、`ELASTICSEARCH_INDEX`、`ELASTICSEARCH_API_KEY`
- `RERANK_PROVIDER=mock | tei`
- `TEI_RERANK_ENDPOINT`、`TEI_RERANK_MODEL`、`TEI_RERANK_API_KEY`
- `LLM_PROVIDER=mock | openai-compatible`
- `LLM_ENDPOINT`、`LLM_API_KEY`、`LLM_MODEL`
- `PARSER_PROVIDER=mock | mineru`
- `MINERU_HTTP_ENDPOINT`、`MINERU_AUTH_TOKEN`、`MINERU_TIMEOUT_MS`

## 替换文档解析器

Parser 刻意隔离在 `ParserAdapter` 之后,因此替换 MinerU 不需要改动摄取、分块、embedding、检索或引用代码。

### 方案一:按配置替换

当新解析器能暴露 MinerU 兼容的 HTTP 形态、或可用一个小型兼容服务包一层时,用此方案。

1. 知识库服务保持不变。
2. 跑一个适配服务,接受与 `MinerUHttpAdapter` 相同的请求风格。
3. 把 parser 端点指向该适配服务:

```bash
PARSER_PROVIDER=mineru
MINERU_HTTP_ENDPOINT=http://your-parser-adapter:8000
MINERU_AUTH_TOKEN=optional-token
```

这是风险最低的部署路径,因为知识库服务仍通过既有的 MinerU 适配边界接收规范化后的解析输出。

### 方案二:新增原生 Parser 适配器

当替换解析器有自己的 API 或输出格式时,用此方案。

1. 在 `services/knowledge/src/parser` 下新建文件,例如 `docling-adapter.ts` 或 `unstructured-adapter.ts`。
2. 实现 `parser-adapter.ts` 中的 `ParserAdapter`。
3. 把解析器响应转换成 `canonical.ts` 中的 `CanonicalDocument`。
4. 返回成功前调用 `validateCanonicalDocument(document)`。
5. 在 `services/knowledge/src/runtime.ts` 的 `KnowledgeRuntimeOptions` 与 `resolveParser()` 中注册该 provider。
6. 添加环境变量,例如:

```bash
PARSER_PROVIDER=docling
DOCLING_ENDPOINT=http://docling:8000
DOCLING_AUTH_TOKEN=optional-token
```

适配器必须保留以下字段,以保证下游引用与检索质量:`nodeId`、`type`、`text`、`headingPath`、`page`、`bbox` 或 `charSpan`、`readingOrder`、`markdown`。

### 推荐灰度路径

1. 对 PDF 与版面复杂的文档,保持 MinerU 为默认解析器。
2. 用新 provider 名称引入替换解析器。
3. 让两个解析器跑同一份评估数据集。
4. 对比解析成功率、降级率、表格抽取质量、标题结构、页码/bbox 引用准确度、下游检索召回。
5. 仅当替换解析器在目标文档集上追平或超过 MinerU 后,再切换 `PARSER_PROVIDER`。

## 架构与设计推演

本节记录服务"为什么这么设计",而不只是"做了什么"。上面那些面向部署的章节足以把它跑起来;本节面向需要扩展或审计检索质量与安全模型的人。

### 分层适配器,运行时解析

每个外部依赖——parser、embedding、向量库、全文索引、reranker、LLM——都藏在一个窄适配接口之后,由 `runtime.ts` 里的环境变量选定(`resolveParser`、`resolveEmbedding`…)。每个都有 `mock` 实现,所以整套服务能在**零外部基础设施**下启动并响应 API;生产逐个组件替换(MinerU、Ollama、Qdrant、TEI、Elasticsearch、OpenAI 兼容 LLM),无需触碰摄取、分块、检索或引用代码。

> 默认全 `mock`,本地无依赖即可起服务;生产逐组件替换,核心链路代码不动。

### `CanonicalDocument` 是解析独立性的支点

任何解析器都必须先把输出规范化成同一个 schema(`parser/canonical.ts`),下游才会运行。每个节点携带足够的溯源信息——`nodeId`、`headingPath`、`page`、`bbox` 或 `charSpan`、`readingOrder`、`markdown`——让一条引用能往返定位回原始文件的精确位置。`validateCanonicalDocument()` 强制不变量(node id 唯一、reading order 指向真实节点、64 位十六进制源 hash),所以有 bug 的解析器会在摄取阶段大声失败,而不是悄悄拉低检索质量。替换 MinerU 只意味着写一个吐出这个形状的适配器——其余不变。

> Parser 可替换的真正支点不是 HTTP 兼容,而是这个带溯源信息的中间契约。

### 结构感知分块 + 中文正确的 token 计数

Chunker 按阅读顺序遍历文档:标题折叠进后续 chunk 的 `headingPath`,表格和公式成为各自拥有引用锚点的独立 chunk,正文按约 512 token 贪心打包、带 64 token 重叠。

Token 计数**不是** `length / 4`。在 bge-m3(sentencepiece)下,CJK 字符约 1 字 1 token,拉丁文本约 4 char/token。旧的统一 `length/4` 对中文低估约 4 倍,于是一个名义 512 token 的 chunk 实际可达约 2000 token;叠加"大表格整块优先"的策略,一张大表就变成一个冲破 embedding 上下文窗口的超大 chunk——这正是一次 Ollama HTTP 500 的直接原因。超大表格现在按行拆分(表头随每个子块重复);确实拆不动的会被打标,embedding 适配器兜底截断。

> 中文 token 估算必须按码点区分 CJK/拉丁,否则大表格直接冲破 embedding 上下文。

### 混合检索:先 RRF 融合,再重排

召回跑两条独立路径——Qdrant(语义)与 BM25(词法)——用 Reciprocal Rank Fusion 融合(`score = Σ 1/(k + rank)`,`k = 60`)。语义召回抓改写表述;词法召回抓精确术语、ID 和被向量抹平的罕见 token。RRF 按**名次**融合,所以两个引擎之间无需分数归一化。Top-K(50)候选随后重排到 final-K(10)。embedding 失败时查询仍可纯 BM25 召回;任一路径或 reranker 失败,请求降级而非报错,`degraded` 标志会在 trace 中返回。

> 双路召回各补盲区,RRF 按名次融合免去跨引擎分数归一;任一路降级不报错。

### Small-to-Big 上下文扩展

排序停留在**小** chunk 上(精确,且不超 reranker 512 token 输入上限),但喂给 LLM 的文本在重排**之后**才放大。`context.mode` 决定放大多少:`chunk`(不扩展)、`window`(按 `chunk_index` 取 ±N 个相邻块,默认)、`section`(同一 `section_id` 的所有块)、`document`(整篇)。扩展按预算裁剪(`maxContextTokens`,每命中独立计),以重排得分最高的块为中心向外扩,同一文档内重叠的窗口会合并成一次取数。关键在于:即便 LLM 看到的是扩展文本,**引用始终锚定在命中的那个小 chunk**(`SearchHit.chunkId`)——于是检索精度与引用稳定性,跟上下文大小解耦。

> rerank 在小块上保精度,喂 LLM 时再扩窗口修边界截断,引用始终锚回命中的小块。

### ACL:调用时现算、约 30s 收敛、纵深防御

可见性从不烘焙进索引。每次检索,服务都现算调用方主体(租户 / 用户 / 部门 / 角色,带 `effectiveFrom`/`effectiveTo` 时间窗)可见的 `acl_hash` 集合,并把它下推进向量与全文两个过滤器——所以连**召回**阶段都看不到一个禁止的 chunk。重排之后,每个候选再对照实时的 chunk 与 document 记录(status、`deleted_at`、可见性)复查一遍,防御索引器/存储的偏移。因为 ACL 是每次调用现算而非重建索引,改一次权限大约在主体写入落库的时间内(约 30s)收敛,无需重索引。引用解析把**所有**失败模式——scope 错、锚点缺失、文档已删、无读权限——统统塌缩成单一 `NOT_FOUND`,所以锚点 id 无法被用来探测是否存在。

> 权限在调用时现算并下推到召回过滤,改权限约 30s 收敛、无需重建索引;引用失败一律塌缩成 NOT_FOUND 防探测。

### 摄取是一个任务状态机

`ingest-processor.ts` 驱动文档走过 `parsing → indexing → searchable`,把规范化 JSON 与 markdown 回写进对象存储 + asset 表,供后续分块与引用查找。解析前会复核源文件 SHA-256(自任务被接受后字节若变更则拒绝)。解析器返回 `degraded` 的结果仍变为可检索但被打标;`failed` 的结果抛错,交给 worker 的重试/退避处理,文档落到终态 `parse_failed`——否则前端会在卡住的 `parsing` 上永远转圈。`shadow` 重建索引会在不影响线上版本的同时,为新版本构建一套 chunk,实现零停机重处理。

> 失败必须落到 `parse_failed` 终态,否则前端永远转圈;shadow 重建支持零停机重索引。

### 请求签名与租户 scope

服务间调用用 HMAC-SHA256 对一个 canonical request(`method + path + sha256(body) + 排序后的 x-octopus-* 头`)签名,以 `timingSafeEqual` 比对,并用 nonce + 时间戳防重放(`knowledge-contracts/auth.ts`)。每个仓储调用都携带 `TenantScope`(`sourceSystemId` + `tenantId`);任何 store 方法都不能在没有它的情况下被调用。

### 持久化分工(以及一处诚实的缺口)

关系数据经 Prisma 进 MySQL;向量存于 Qdrant;全文在 Elasticsearch(或 in-memory BM25)。**对象存储目前仍是进程内的**(`InMemoryKnowledgeObjectStore`)——开发够用,但意味着原始上传和解析产物在重启后丢失。生产必须把它换成 S3/MinIO;否则一个源对象已丢失的失败摄取,会永远报"source object not found"。

> 对象存储目前是进程内内存版,生产必须换 S3/MinIO,否则重启即丢原始上传。

## 测试

```bash
pnpm test
```
