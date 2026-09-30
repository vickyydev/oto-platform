import Anthropic from "@anthropic-ai/sdk";

/**
 * One Anthropic client for every AI feature in the app (Ask OTO, SOP
 * extraction, event and BEO parsing, form translation). The app used to call
 * OpenAI; the park runs on an Anthropic key now, so the OpenAI names are gone.
 * ANTHROPIC_BASE_URL is honoured because a proxy in front of the model is a
 * real deployment choice.
 */
let client: Anthropic | null = null;

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function getAnthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
  }
  return client;
}

/** The strong model for structured extraction (events, BEOs, SOP steps). */
export const DEFAULT_AI_MODEL =
  process.env.ANTHROPIC_MODEL?.trim() || "claude-opus-5";

/** The fast model for high-frequency, short answers (Ask OTO, translation). */
export const FAST_AI_MODEL =
  process.env.ANTHROPIC_FAST_MODEL?.trim() || "claude-haiku-4-5-20251001";

/**
 * The admin-editable model setting used to hold an OpenAI model name. Any
 * stored value that is not a Claude model falls back to the default, so old
 * settings rows keep working without a data migration.
 */
export function resolveAiModel(stored?: string | null): string {
  const name = stored?.trim();
  return name && name.startsWith("claude-") ? name : DEFAULT_AI_MODEL;
}

export interface AiCompleteOptions {
  model?: string | null;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}

/** One system+user round trip returning the answer text. */
export async function aiComplete(opts: AiCompleteOptions): Promise<string> {
  const message = await getAnthropic().messages.create({
    model: resolveAiModel(opts.model),
    max_tokens: opts.maxTokens,
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/** Strip the markdown fences a model may wrap around requested JSON. */
export function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
}
