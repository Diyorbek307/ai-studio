export interface AgentInfo {
  no: number;
  name: string;
  dept: string;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info(message: string): void {
    console.log(`${stamp()}  ${message}`);
  },
  agent(agent: AgentInfo, message: string): void {
    console.log(`${stamp()}  [№${agent.no} ${agent.name}] ${message}`);
  },
  warn(message: string): void {
    console.warn(`${stamp()}  ⚠ ${message}`);
  },
  error(message: string): void {
    console.error(`${stamp()}  ✖ ${message}`);
  },
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
