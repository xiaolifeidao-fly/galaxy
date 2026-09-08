// 内部统一格式 —— 不绑死 OpenAI 也不绑死 Anthropic，做一层中性 IR。

export type Role = "system" | "user" | "assistant";

export type CacheHint = { type: "ephemeral"; ttl?: "5m" | "1h" };

export type ContentBlock =
  | { type: "text"; text: string; cacheHint?: CacheHint }
  | {
      type: "image";
      mediaType: string; // image/jpeg | png | gif | webp
      data?: string;     // base64
      url?: string;
      cacheHint?: CacheHint;
    }
  | {
      // Anthropic extended thinking 输出 / 历史回填
      type: "thinking";
      text: string;
      signature?: string;
      cacheHint?: CacheHint;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      cacheHint?: CacheHint;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
      cacheHint?: CacheHint;
    }
  | {
      // OpenAI input_audio
      type: "audio";
      format: "wav" | "mp3" | string;
      data: string; // base64
      transcript?: string;
    }
  | {
      // PDF / 其它文件附件。OpenAI: file 块；Anthropic: document 块
      type: "file";
      mediaType: string; // application/pdf 等
      data?: string;     // base64 内联
      url?: string;
      fileId?: string;   // OpenAI Files API id
      filename?: string;
      cacheHint?: CacheHint;
    };

export interface ChatMessage {
  role: Role;
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  cacheHint?: CacheHint;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

// Anthropic 风格的"扩展思考"配置
export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens?: number;
}

// OpenAI 风格 reasoning 控制（o1/o3）
export interface ReasoningConfig {
  effort?: "minimal" | "low" | "medium" | "high";
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  thinking?: ThinkingConfig;
  reasoning?: ReasoningConfig;
  passthrough?: Record<string, unknown>;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | string
  | null;

export type ChatChunk =
  | { type: "text"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "image"; mediaType: string; data: string; name?: string } // base64，模型生成的图
  | { type: "file"; mediaType: string; name: string; data?: string; text?: string } // 模型生成的文件：text=文本内容 / data=base64 二进制

  | { type: "thinking_signature"; signature: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_use_args_delta"; index: number; partialJson: string }
  | { type: "tool_use_stop"; index: number }
  | {
      type: "done";
      finish_reason?: FinishReason;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };

export interface ChatCallContext {
  signal: AbortSignal;
  requestId: string;
}

export interface ModelAdapter {
  readonly name: string;
  chatStream(req: ChatRequest, ctx: ChatCallContext): AsyncIterable<ChatChunk>;
}
