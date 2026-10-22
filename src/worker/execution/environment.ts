import type { ModelConnection } from '../../shared/types';
import type { ArtifactsBinding } from '../artifacts';
import type { CommandResult, GitPermission, PrepareOptions } from '../../../runner/sandbox';
import type { ModelEnv } from '../model-adapter';
import type { InstallMode, InstallPlan } from '../package-manager';

export interface SandboxRunner {
  prepare(repositories: GitPermission[], options?: PrepareOptions): Promise<void>;
  command(argv: string[], cwd?: string, timeoutMs?: number): Promise<CommandResult>;
  destroy(): Promise<void>;
  install?(plan: InstallPlan, mode?: InstallMode): Promise<CommandResult>;
  check?(script: string, timeoutMs: number): Promise<CommandResult>;
  startPreview?(command?: string | string[], readinessMs?: number): Promise<void>;
  preview?(request: Request): Promise<Response>;
  collect?(script: string, timeoutMs: number, capBytes: number): Promise<CommandResult>;
}

export interface ExecutionEnv {
  ARTIFACTS?: ArtifactsBinding;
  SANDBOX?: { getByName(name: string): SandboxRunner };
  AI?: { run(model: string, input: Record<string, unknown>, options?: { gateway: { id: string }; signal?: AbortSignal }): Promise<unknown> };
  MODEL?: string;
  AI_GATEWAY_ID?: string;
  TEST_COMMAND?: string;
  assertModelAllowed?: (model: ModelConnection) => Promise<void>;
  modelAccess?: ModelEnv['modelAccess'];
}

export type AuthorityGuard = () => Promise<void>;

export const unrestricted: AuthorityGuard = async () => {};
