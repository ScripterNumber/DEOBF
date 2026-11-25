import type { z, ZodRawShape } from 'zod';
import type { Workspace } from './workspace.js';

export interface ToolContext {
  ws: Workspace;
  /** absolute path of the bundled native Luau tools (luau-compile, luau-analyze, luau-ast) */
  luauDir: string;
}
export interface ToolResult {
  /** human/AI readable main output (always copyable) */
  text: string;
  /** structured data (returned as JSON when format=json, and to the web UI) */
  data?: unknown;
  /** workspace-relative files written by the tool */
  files?: string[];
}
export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  category: 'workspace' | 'analysis' | 'deobfuscation' | 'search' | 'vm' | 'bytecode' | 'blob' | 'transpile' | 'luau';
  description: string;
  input: S;
  /** read-only tools never modify the workspace */
  readOnly?: boolean;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}
export const defineTool = <S extends ZodRawShape>(t: ToolDef<S>): ToolDef<S> => t;
