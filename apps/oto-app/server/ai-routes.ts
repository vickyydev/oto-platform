import { Express, Request, Response, NextFunction } from "express";
import OpenAI from "openai";
import { db } from "./db";
import { settings, branches } from "../shared/schema";
import { eq } from "drizzle-orm";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
  }
  return openaiClient;
}

async function getSettingValue(key: string): Promise<string> {
  const setting = await db.query.settings.findFirst({
    where: eq(settings.key, key),
  });
  if (!setting) {
    throw new Error(`Setting not found: ${key}. Please add this setting in System Settings.`);
  }
  return setting.value;
}



interface ExtractEventRequest {
  notes_text: string;
  existing_form_data?: Record<string, unknown>;
  branch_context?: { branch_id: string; branch_name: string };
  timezone?: string;
}

interface ParseBeoRequest {
  text: string;
  existingData?: Record<string, unknown>;
}



export function registerAIRoutes(app: Express, requireAuth: any) {

  app.get("/api/ai/available-models", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const openai = getOpenAI();
      const modelsList = await openai.models.list();
      
      // Filter for GPT models only
      const gptModels = modelsList.data
        .filter(m => m.id.includes("gpt"))
        .map(m => ({
          id: m.id,
          label: m.id,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      
      res.json({ models: gptModels });
    } catch (error: any) {
      console.error("[AI Available Models] Error:", error);
      if (error.message?.includes("Missing credentials") || error.message?.includes("API key")) {
        return res.status(503).json({ 
          message: "AI service not configured. Please set up OpenAI integration." 
        });
      }
      next(error);
    }
  });

  app.post("/api/ai/extract-event", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { notes_text, existing_form_data, branch_context, timezone } = req.body as ExtractEventRequest;

      if (!notes_text || !notes_text.trim()) {
        return res.status(400).json({ message: "notes_text is required" });
      }

      let advice: string;
      try {
        advice = await getSettingValue("ai_event_extraction_advice");
      } catch (error: any) {
        console.error("[AI Extract Event] Missing setting:", error.message);
        return res.status(500).json({ message: error.message });
      }

      let outputFormat: string;
      try {
        outputFormat = await getSettingValue("ai_event_extraction_output_format");
      } catch (error: any) {
        console.error("[AI Extract Event] Missing setting:", error.message);
        return res.status(500).json({ message: error.message });
      }

      const prompt = advice + "\n\n" + outputFormat;

      let model: string;
      try {
        model = await getSettingValue("ai_event_extraction_model");
      } catch (error: any) {
        console.error("[AI Extract Event] Missing model setting:", error.message);
        return res.status(500).json({ message: error.message });
      }

      const now = new Date();

      let contextInfo = "";
      if (branch_context?.branch_name) {
        contextInfo = `\nCurrently selected branch: ${branch_context.branch_name}`;
      }

      // Fetch tenant branches and build branch list for the model
      const tenantBranches = await db.select({
        id: branches.id,
        name: branches.name,
        timezone: branches.timezone,
      }).from(branches).where(eq(branches.tenantId, req.user!.tenantId));

      const branchLines = tenantBranches.map((b) => {
        const localTime = new Intl.DateTimeFormat("en-CA", {
          timeZone: b.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(now);
        const localWeekday = new Intl.DateTimeFormat("en-US", {
          timeZone: b.timezone,
          weekday: "long",
        }).format(now);
        return `- id: ${b.id} | name: ${b.name} | timezone: ${b.timezone} | current local time: ${localTime} (${localWeekday})`;
      }).join("\n");

      const branchSection = tenantBranches.length > 0
        ? `\n\nAvailable branches:\n${branchLines}`
        : "";

      const userMessage = `Extract event details from these notes:
${contextInfo}

Notes:
${notes_text}

${existing_form_data ? `\nExisting form data (use these as the baseline — carry all values forward into extracted, only updating fields that are explicitly mentioned or corrected in the notes above):\n${JSON.stringify(existing_form_data, null, 2)}` : ""}`;

      console.log("[AI Extract Event] System prompt:\n", prompt + branchSection);
      console.log("[AI Extract Event] User message:\n", userMessage);

      const openai = getOpenAI();
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: prompt + branchSection },
          { role: "user", content: userMessage },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      const responseText = completion.choices[0]?.message?.content;
      if (!responseText) {
        throw new Error("No response from AI");
      }

      const parsed = JSON.parse(responseText);
      console.log("[AI Extract Event] Response:\n", JSON.stringify(parsed, null, 2));
      res.json(parsed);
    } catch (error: any) {
      console.error("[AI Extract Event] Error:", error);
      if (error.message?.includes("Missing credentials") || error.message?.includes("API key")) {
        return res.status(503).json({ 
          message: "AI service not configured. Please set up OpenAI integration." 
        });
      }
      if (error.code === "insufficient_quota" || error.status === 429) {
        return res.status(429).json({ message: "AI service quota exceeded. Please try again later." });
      }
      next(error);
    }
  });

  app.post("/api/ai/parse-beo", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { text, existingData } = req.body as ParseBeoRequest;

      if (!text || !text.trim()) {
        return res.status(400).json({ message: "text is required" });
      }

      let advice: string;
      try {
        advice = await getSettingValue("ai_beo_parsing_advice");
      } catch (error: any) {
        console.error("[AI Parse BEO] Missing setting:", error.message);
        return res.status(500).json({ message: error.message });
      }

      let outputFormat: string;
      try {
        outputFormat = await getSettingValue("ai_beo_parsing_output_format");
      } catch (error: any) {
        console.error("[AI Parse BEO] Missing setting:", error.message);
        return res.status(500).json({ message: error.message });
      }

      let model: string;
      try {
        model = await getSettingValue("ai_event_extraction_model");
      } catch (error: any) {
        console.error("[AI Parse BEO] Missing model setting:", error.message);
        return res.status(500).json({ message: error.message });
      }

      const prompt = advice + "\n\n" + outputFormat;

      const userMessage = existingData
        ? `Existing event data (only update fields that are explicitly mentioned in the new text, leave everything else unchanged):
${JSON.stringify(existingData, null, 2)}

New text to parse:
${text}`
        : text;

      console.log("[AI Parse BEO] System prompt:\n", prompt);
      console.log("[AI Parse BEO] User message:\n", userMessage);

      const openai = getOpenAI();
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      });

      const responseText = completion.choices[0]?.message?.content;
      if (!responseText) {
        throw new Error("No response from AI");
      }

      const parsed = JSON.parse(responseText);
      console.log("[AI Parse BEO] Response:\n", JSON.stringify(parsed, null, 2));
      res.json(parsed);
    } catch (error: any) {
      console.error("[AI Parse BEO] Error:", error);
      if (error.message?.includes("Missing credentials") || error.message?.includes("API key")) {
        return res.status(503).json({
          message: "AI service not configured. Please set up OpenAI integration."
        });
      }
      if (error.code === "insufficient_quota" || error.status === 429) {
        return res.status(429).json({ message: "AI service quota exceeded. Please try again later." });
      }
      next(error);
    }
  });
}
