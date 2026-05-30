export type LLMMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LLMRequest = {
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  signal?: AbortSignal;
};

export type LLMFinishReason = "stop" | "length" | "content_filter" | "other";

export type LLMUsage = {
  promptTokens?: number;
  completionTokens?: number;
};

export type LLMMetadata = {
  provider: string;
  model: string;
};

export type LLMSuccess = {
  status: "ok";
  text: string;
  finishReason: LLMFinishReason;
  usage?: LLMUsage;
  metadata: LLMMetadata;
};

export type LLMFailure = {
  status: "failed";
  reason: string;
  retryable: boolean;
};

export type LLMResponse = LLMSuccess | LLMFailure;

export interface LLMAdapter {
  readonly metadata: LLMMetadata;
  generate(request: LLMRequest): Promise<LLMResponse>;
}
