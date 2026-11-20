import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { recordCost } from "./budget.js";
import { config } from "./config.js";
import { type AgentInfo, log } from "./log.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ImageInput {
  mediaType: "image/jpeg" | "image/png";
  base64: string;
}

export interface AskOptions<S extends z.ZodType> {
  agent: AgentInfo;
  /** Роль и правила агента — стабильная часть, не меняется от вызова к вызову. */
  system: string;
  /** Библия сериала и прочий общий контекст — кэшируется между агентами. */
  context?: string;
  prompt: string;
  schema: S;
  effort?: Effort;
  images?: ImageInput[];
  episodeId?: string;
  /** Ответ для демо-режима без ключа Claude. */
  mock: () => z.infer<S>;
}

let client: Anthropic | undefined;
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export class ClaudeRefusalError extends Error {
  constructor(agent: AgentInfo, explanation: string) {
    super(`Claude отказался выполнять задачу агента №${agent.no}: ${explanation}`);
    this.name = "ClaudeRefusalError";
  }
}

function costOf(usage: Anthropic.Beta.BetaUsage): number {
  const { priceInPerMTok, priceOutPerMTok, priceCacheReadPerMTok } = config.llm;
  const input = usage.input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return (
    (input * priceInPerMTok + cacheWrite * priceInPerMTok * 1.25 + cacheRead * priceCacheReadPerMTok + output * priceOutPerMTok) /
    1_000_000
  );
}

/**
 * Один вызов Claude, который возвращает объект строго по zod-схеме.
 * В демо-режиме возвращает opts.mock().
 */
export async function askStructured<S extends z.ZodType>(opts: AskOptions<S>): Promise<z.infer<S>> {
  if (config.llm.provider === "mock") {
    return opts.mock();
  }

  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: opts.system }];
  if (opts.context) {
    system.push({ type: "text", text: opts.context, cache_control: { type: "ephemeral" } });
  }

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...(opts.images ?? []).map(
      (img): Anthropic.Beta.BetaImageBlockParam => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.base64 },
      }),
    ),
    { type: "text", text: opts.prompt },
  ];

  let response;
  try {
    response = await getClient().beta.messages.parse({
      model: config.llm.model,
      max_tokens: 16000,
      // Если классификатор безопасности ошибочно отклонит запрос, сервер сам повторит его на запасной модели.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: opts.effort ?? "medium",
        format: betaZodOutputFormat(opts.schema),
      },
      system,
      messages: [{ role: "user", content }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new Error("Claude: неверный ANTHROPIC_API_KEY");
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new Error("Claude: слишком много запросов, попробуй позже");
    }
    if (error instanceof Anthropic.APIError) {
      throw new Error(`Claude API ${error.status ?? ""}: ${error.message}`);
    }
    throw error;
  }

  const usd = costOf(response.usage);
  recordCost({ agent: opts.agent, kind: "llm", usd, detail: config.llm.model, episodeId: opts.episodeId });
  log.agent(opts.agent, `Claude ответил ($${usd.toFixed(4)})`);

  if (response.stop_reason === "refusal") {
    throw new ClaudeRefusalError(opts.agent, response.stop_details?.explanation ?? "без пояснения");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`Агент №${opts.agent.no}: ответ Claude обрезан по длине`);
  }
  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new Error(`Агент №${opts.agent.no}: Claude вернул ответ не по схеме`);
  }
  return opts.schema.parse(parsed) as z.infer<S>;
}

export function isMockLlm(): boolean {
  return config.llm.provider === "mock";
}
