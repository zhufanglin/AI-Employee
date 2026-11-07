/** 能力（capability）统一契约：与原版 agent-tool-box 的 tool_box.py 输出同构 */
export interface CapabilityResult<T = any> {
  success: boolean;
  data: T | null;
  error: string | null;
  error_code?: string | null;
}

export interface CapabilityContext {
  userId: string;
  phone: string | null;
  params: Record<string, any>;
}

export interface CapabilityDescriptor {
  name: string;
  title: string;
  category: string;
  description: string;
  params: Record<string, string>;
}

export type CapabilityHandler = (ctx: CapabilityContext) => Promise<any>;
