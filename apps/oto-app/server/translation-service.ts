import { aiComplete, FAST_AI_MODEL, stripJsonFences } from "./lib/anthropic";
import { batchProcess } from "./lib/batch";

const LANGUAGE_NAMES: Record<string, string> = {
  th: "Thai",
  ru: "Russian", 
  zh: "Chinese (Simplified)",
};

interface TranslationItem {
  key: string;
  value: string;
}

interface TranslationResult {
  key: string;
  translatedValue: string;
  success: boolean;
  error?: string;
}

export async function translateTexts(
  texts: TranslationItem[],
  targetLang: string
): Promise<TranslationResult[]> {
  const languageName = LANGUAGE_NAMES[targetLang];
  if (!languageName) {
    throw new Error(`Unsupported target language: ${targetLang}`);
  }

  if (texts.length === 0) {
    return [];
  }

  const batchSize = 20;
  const batches: TranslationItem[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const batchResults = await batchProcess(
    batches,
    async (batch) => translateBatch(batch, languageName),
    { 
      concurrency: 2, 
      retries: 5,
      onProgress: (completed, total) => {
        console.log(`[TranslationService] Progress: ${completed}/${total} batches`);
      }
    }
  );

  return batchResults.flat();
}

async function translateBatch(
  items: TranslationItem[],
  languageName: string
): Promise<TranslationResult[]> {
  try {
    const inputObj: Record<string, string> = {};
    for (const item of items) {
      inputObj[item.key] = item.value;
    }

    const content = await aiComplete({
      model: FAST_AI_MODEL,
      system: `You are a professional translator specializing in UI/UX text localization.
Translate the provided JSON object values from English to ${languageName}. 
Keep the keys exactly the same, only translate the values.
Maintain the tone and context appropriate for a family-friendly children's play center check-in form.
Return ONLY valid JSON with the same keys and translated values.
For very short texts like "Yes" or "No", provide the appropriate ${languageName} equivalent.
Do NOT translate placeholders like {{name}} - keep them as-is.`,
      user: JSON.stringify(inputObj, null, 2),
      maxTokens: 4096,
    });

    if (!content) {
      throw new Error("Empty response from translation API");
    }

    const translations = JSON.parse(stripJsonFences(content)) as Record<string, string>;

    return items.map((item) => ({
      key: item.key,
      translatedValue: translations[item.key] || item.value,
      success: !!translations[item.key],
      error: translations[item.key] ? undefined : "Translation not found in response",
    }));
  } catch (error) {
    console.error("[TranslationService] Batch translation failed:", error);
    return items.map((item) => ({
      key: item.key,
      translatedValue: item.value,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }));
  }
}

export async function translateSingleText(
  text: string,
  targetLang: string
): Promise<string> {
  const languageName = LANGUAGE_NAMES[targetLang];
  if (!languageName) {
    throw new Error(`Unsupported target language: ${targetLang}`);
  }

  try {
    const content = await aiComplete({
      model: FAST_AI_MODEL,
      system: `Translate the following English text to ${languageName}. Return ONLY the translated text, no explanations.`,
      user: text,
      maxTokens: 1024,
    });

    return content.trim() || text;
  } catch (error) {
    console.error("[TranslationService] Single translation failed:", error);
    return text;
  }
}
