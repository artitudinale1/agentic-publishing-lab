import type OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { createCatalog, type Article } from "./articles.js";
import {
  ARTICLE_LENGTHS,
  instructionsFor,
  resolveArticleLength,
  type EditorialRequest,
} from "./editorial.js";
import { articleTools, runToolCall, toolsFor } from "./tools.js";

/** Hard stop so a tool loop cannot keep calling the model. */
export const MAX_MODEL_CALLS = 5;

/** Existing-article mode, and runs that are not an editorial generate request. */
export const EXISTING_ARTICLE_MAX_OUTPUT_TOKENS = 512;

export function maxOutputTokens(request?: EditorialRequest): number {
  if (request?.mode === "generate") {
    return ARTICLE_LENGTHS[resolveArticleLength(request.length)].maxOutputTokens;
  }

  return EXISTING_ARTICLE_MAX_OUTPUT_TOKENS;
}

export type ModelClient = {
  responses: {
    create: (
      params: OpenAI.Responses.ResponseCreateParamsNonStreaming,
    ) => Promise<OpenAI.Responses.Response>;
  };
};

export type ExperimentResult = {
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  finalText: string;
  stoppedAtCallLimit: boolean;
  status: "completed" | "incomplete";
  incompleteReason: string | null;
  /** Last draft successfully created or updated in this run, copied from the catalog. */
  draft: Article | null;
};

/** The model's summary, then the catalog article when this run stored a draft. */
export function formatRunOutput(result: ExperimentResult): string {
  if (!result.draft) {
    return result.finalText;
  }

  return [
    result.finalText,
    "",
    `[draft] slug=${result.draft.slug}`,
    result.draft.title,
    result.draft.summary,
    "",
    result.draft.body,
  ].join("\n");
}

type Log = (line: string) => void;

export type ExperimentNotice =
  | { type: "model"; call: number; model: string; inputTokens: number; outputTokens: number }
  | {
      type: "tool";
      phase: "request" | "result" | "skipped";
      name: string;
      callId: string;
      arguments?: string;
      output?: string;
    }
  | { type: "usage"; apiCalls: number; inputTokens: number; outputTokens: number }
  | { type: "incomplete"; reason: string };

const INSTRUCTIONS = [
  "You help with a small in-memory article catalog.",
  "You can call findArticle, createDraft, updateDraft, and validateArticle.",
  "Choose which tools to call and in which order.",
  "Use only tool results. Do not invent catalog entries.",
  "If a tool reports an error, a duplicate slug, a missing article, or a published article, say that plainly.",
  "validateArticle checks a saved draft. It does not approve or publish.",
  "You cannot approve or publish.",
].join(" ");

function outputText(response: OpenAI.Responses.Response): string {
  const parts: string[] = [];

  for (const item of response.output) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content) {
      if (content.type === "output_text") {
        parts.push(content.text);
      }
    }
  }

  if (parts.length > 0) {
    return parts.join("");
  }

  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  return "";
}

export async function runExperiment(options: {
  client: ModelClient;
  model: string;
  prompt: string;
  request?: EditorialRequest;
  log?: Log;
  notice?: (notice: ExperimentNotice) => void;
}): Promise<ExperimentResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const notice = options.notice ?? (() => undefined);
  const catalog = createCatalog();
  const tools = options.request ? toolsFor(options.request) : articleTools;
  const instructions = options.request ? instructionsFor(options.request) : INSTRUCTIONS;
  const outputTokenLimit = maxOutputTokens(options.request);
  if (options.request?.mode === "generate") {
    log(`[article] length=${resolveArticleLength(options.request.length)}`);
  }
  log(`[api] max_output_tokens=${outputTokenLimit}`);
  const input: OpenAI.Responses.ResponseInput = [
    { role: "user", content: options.prompt },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let stoppedAtCallLimit = false;
  let finalText = "";
  let draftSlug: string | null = null;

  const storedDraft = (): Article | null => {
    if (draftSlug === null) {
      return null;
    }

    const article = catalog.find((entry) => entry.slug === draftSlug);
    if (!article || article.status !== "draft") {
      return null;
    }

    return { ...article };
  };

  for (let callNumber = 1; callNumber <= MAX_MODEL_CALLS; callNumber += 1) {
    const response = await options.client.responses.create({
      model: options.model,
      instructions,
      input,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: outputTokenLimit,
      store: false,
    });

    const usedInput = response.usage?.input_tokens ?? 0;
    const usedOutput = response.usage?.output_tokens ?? 0;
    inputTokens += usedInput;
    outputTokens += usedOutput;

    const returnedModel = response.model?.trim() ?? "";
    log(`[api] call ${callNumber} of ${MAX_MODEL_CALLS}`);
    log(`[api] model=${returnedModel || "unavailable"}`);
    log(`[api] input_tokens=${usedInput} output_tokens=${usedOutput}`);
    notice({
      type: "model",
      call: callNumber,
      model: returnedModel || "unavailable",
      inputTokens: usedInput,
      outputTokens: usedOutput,
    });

    const toolCalls = response.output.filter((item) => item.type === "function_call");

    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason ?? "unknown";
      log(`[api] status=incomplete reason=${reason}`);
      notice({ type: "incomplete", reason });

      for (const toolCall of toolCalls) {
        log(
          `[tool] request name=${toolCall.name} call_id=${toolCall.call_id} arguments=${toolCall.arguments}`,
        );
        log(`[incomplete] did not execute call_id=${toolCall.call_id}`);
        notice({
          type: "tool",
          phase: "skipped",
          name: toolCall.name,
          callId: toolCall.call_id,
          arguments: toolCall.arguments,
        });
      }

      finalText = outputText(response);
      log(
        `[usage] api_calls=${callNumber} input_tokens=${inputTokens} output_tokens=${outputTokens}`,
      );
      notice({ type: "usage", apiCalls: callNumber, inputTokens, outputTokens });
      return {
        apiCalls: callNumber,
        inputTokens,
        outputTokens,
        finalText: finalText || "The model response was incomplete.",
        stoppedAtCallLimit: false,
        status: "incomplete",
        incompleteReason: reason,
        draft: storedDraft(),
      };
    }

    if (toolCalls.length === 0) {
      finalText = outputText(response);
      log(
        `[usage] api_calls=${callNumber} input_tokens=${inputTokens} output_tokens=${outputTokens}`,
      );
      notice({ type: "usage", apiCalls: callNumber, inputTokens, outputTokens });
      return {
        apiCalls: callNumber,
        inputTokens,
        outputTokens,
        finalText,
        stoppedAtCallLimit,
        status: "completed",
        incompleteReason: null,
        draft: storedDraft(),
      };
    }

    if (callNumber === MAX_MODEL_CALLS) {
      stoppedAtCallLimit = true;
      for (const toolCall of toolCalls) {
        log(
          `[tool] request name=${toolCall.name} call_id=${toolCall.call_id} arguments=${toolCall.arguments}`,
        );
        log(`[limit] model call limit reached; did not execute call_id=${toolCall.call_id}`);
        notice({
          type: "tool",
          phase: "skipped",
          name: toolCall.name,
          callId: toolCall.call_id,
          arguments: toolCall.arguments,
        });
      }
      finalText = outputText(response);
      break;
    }

    input.push(...toResponseInputItems(response.output));

    // parallel_tool_calls is false, so the model is asked for one tool.
    // A completed response can still list several. Run those in order.
    for (const toolCall of toolCalls) {
      log(
        `[tool] request name=${toolCall.name} call_id=${toolCall.call_id} arguments=${toolCall.arguments}`,
      );
      notice({
        type: "tool",
        phase: "request",
        name: toolCall.name,
        callId: toolCall.call_id,
        arguments: toolCall.arguments,
      });

      const outcome = runToolCall(
        catalog,
        toolCall.name,
        toolCall.arguments,
        options.request,
        log,
      );
      if (outcome.ok && ("created" in outcome.result || "updated" in outcome.result)) {
        draftSlug = outcome.result.article.slug;
      }
      const output = JSON.stringify(outcome);

      log(`[tool] result call_id=${toolCall.call_id} ${output}`);
      notice({
        type: "tool",
        phase: "result",
        name: toolCall.name,
        callId: toolCall.call_id,
        output,
      });

      input.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output,
      });
    }
  }

  log(
    `[usage] api_calls=${MAX_MODEL_CALLS} input_tokens=${inputTokens} output_tokens=${outputTokens}`,
  );
  notice({ type: "usage", apiCalls: MAX_MODEL_CALLS, inputTokens, outputTokens });

  if (!finalText) {
    finalText = `Stopped after ${MAX_MODEL_CALLS} model calls before a final answer.`;
  }

  return {
    apiCalls: MAX_MODEL_CALLS,
    inputTokens,
    outputTokens,
    finalText,
    stoppedAtCallLimit,
    status: "completed",
    incompleteReason: null,
    draft: storedDraft(),
  };
}
