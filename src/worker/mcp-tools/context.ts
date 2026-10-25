export interface McpToolContext {
  call<T>(path: string, body?: Record<string, unknown>, key?: string): Promise<T>;
  fetchBytes?(path: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  origin: string;
}
