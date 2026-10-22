

export interface McpToolContext {
  call<T>(path: string, body?: Record<string, unknown>, key?: string): Promise<T>;
  origin: string;
}
