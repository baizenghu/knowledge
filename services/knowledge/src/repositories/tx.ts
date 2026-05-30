/**
 * Prisma 事务客户端的不透明类型。
 *
 * Store 接口在方法签名上接受可选的 `tx?: KnowledgeTxClient`，让 service 层
 * 用 `prisma.$transaction(async (tx) => store.fooBar(..., tx))` 把多次调用串
 * 进同一个事务。Prisma 传入的 tx 形状与外层 PrismaClient 兼容（同一组 model
 * 方法），所以 Prisma 实现内部按 `tx ?? this.prisma` 路由即可。
 *
 * 这里用 `unknown` 是为了让 store 接口不依赖 `@prisma/client` 类型——
 * InMemory 实现完全忽略 tx，Prisma 实现内部 cast 成 PrismaLike。
 */
export type KnowledgeTxClient = unknown;
