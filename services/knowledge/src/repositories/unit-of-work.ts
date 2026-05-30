export interface KnowledgeUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export class NoopKnowledgeUnitOfWork implements KnowledgeUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
