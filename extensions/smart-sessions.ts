import { complete, type Model, type Api } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const skillPattern = /^\s*\/skill:(\S+)\s*([\s\S]*)/;

const SUMMARY_PROMPT =
  "Summarize the user's request in 5-10 words max. Output ONLY the summary, nothing else. No quotes, no punctuation at the end.";

const CHEAP_MODEL_CANDIDATES = [
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "github-copilot", id: "claude-haiku-4.5" },
];

async function pickCheapModel(ctx: {
  model: Model<Api> | null;
  modelRegistry: {
    find: (p: string, id: string) => Model<Api> | undefined;
    getAvailable?: () => Model<Api>[];
    getApiKeyAndHeaders: (
      m: Model<Api>,
    ) => Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
      | { ok: false; error: string }
    >;
  };
}): Promise<{ model: Model<Api>; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } | null> {
  const candidates: Model<Api>[] = [];
  const seen = new Set<string>();
  const add = (model: Model<Api> | undefined | null) => {
    if (!model) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  for (const candidate of CHEAP_MODEL_CANDIDATES) {
    add(ctx.modelRegistry.find(candidate.provider, candidate.id));
  }

  // If model IDs move again, still prefer cheap-looking models from the supported providers.
  for (const model of ctx.modelRegistry.getAvailable?.() ?? []) {
    if ((model.provider === "openai-codex" || model.provider === "github-copilot") && /mini|haiku/i.test(model.id)) add(model);
  }

  add(ctx.model);

  for (const model of candidates) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok) return { model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  let named = false;

  pi.on("session_start", () => {
    named = !!pi.getSessionName();
  });

  pi.on("input", async (event, ctx) => {
    if (named) return;

    const match = event.text.match(skillPattern);
    const skillName = match?.[1] ?? null;
    const userPrompt = (match ? match[2] : event.text).trim();
    const prefix = skillName ? `[${skillName}] ` : "";

    if (!userPrompt) {
      if (skillName) {
        named = true;
        pi.setSessionName(`[${skillName}]`);
      }
      return;
    }

    named = true;

    // Set a temporary name immediately so something shows up
    pi.setSessionName(`${prefix}${userPrompt.slice(0, 60)}`);

    // Summarize in the background with a cheap model.
    // Keep this fire-and-forget so session naming never delays skill expansion.
    void (async () => {
      try {
        const cheap = await pickCheapModel(ctx);
        if (!cheap) return;

        const response = await complete(
          cheap.model,
          {
            systemPrompt: SUMMARY_PROMPT,
            messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
          },
          { apiKey: cheap.apiKey, headers: cheap.headers, env: cheap.env },
        );

        const summary = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("")
          .trim();

        if (summary) {
          pi.setSessionName(`${prefix}${summary}`);
        }
      } catch {
        // Keep the truncated name, no big deal
      }
    })();
  });
}
