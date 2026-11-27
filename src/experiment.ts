import type OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { createCatalog } from "./articles";
import { articleTools, runToolCall } from "./tools";

/** Hard stop so a tool loop cannot keep calling the model. */
export const MAX_MODEL_CALLS = 5;

/** Conservative cap for each model response. */
export const MAX_OUTPUT_TOKENS = 512;

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
};

type Log = (line: string) => void;

const INSTRUCTIONS = [
  "You help with a small in-memory article catalog.",
  "You can call findArticle, createDraft, and updateDraft.",
  "Choose which tools to call and in which order.",
  "Use only tool results. Do not invent catalog entries.",
  "If a tool reports an error, a duplicate slug, a missing article, or a published article, say that plainly.",
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
  log?: Log;
}): Promise<ExperimentResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const catalog = createCatalog();
  const input: OpenAI.Responses.ResponseInput = [
    { role: "user", content: options.prompt },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let stoppedAtCallLimit = false;
  let finalText = "";

  for (let callNumber = 1; callNumber <= MAX_MODEL_CALLS; callNumber += 1) {
    const response = await options.client.responses.create({
      model: options.model,
      instructions: INSTRUCTIONS,
      input,
      tools: articleTools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: MAX_OUTPUT_TOKENS,
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

    const toolCalls = response.output.filter((item) => item.type === "function_call");

    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason ?? "unknown";
      log(`[api] status=incomplete reason=${reason}`);

      for (const toolCall of toolCalls) {
        log(
          `[tool] request name=${toolCall.name} call_id=${toolCall.call_id} arguments=${toolCall.arguments}`,
        );
        log(`[incomplete] did not execute call_id=${toolCall.call_id}`);
      }

      finalText = outputText(response);
      log(
        `[usage] api_calls=${callNumber} input_tokens=${inputTokens} output_tokens=${outputTokens}`,
      );
      return {
        apiCalls: callNumber,
        inputTokens,
        outputTokens,
        finalText: finalText || "The model response was incomplete.",
        stoppedAtCallLimit: false,
        status: "incomplete",
        incompleteReason: reason,
      };
    }

    if (toolCalls.length === 0) {
      finalText = outputText(response);
      log(
        `[usage] api_calls=${callNumber} input_tokens=${inputTokens} output_tokens=${outputTokens}`,
      );
      return {
        apiCalls: callNumber,
        inputTokens,
        outputTokens,
        finalText,
        stoppedAtCallLimit,
        status: "completed",
        incompleteReason: null,
      };
    }

    if (callNumber === MAX_MODEL_CALLS) {
      stoppedAtCallLimit = true;
      for (const toolCall of toolCalls) {
        log(
          `[tool] request name=${toolCall.name} call_id=${toolCall.call_id} arguments=${toolCall.arguments}`,
        );
        log(`[limit] model call limit reached; did not execute call_id=${toolCall.call_id}`);
      }
      finalText = outputText(response);
      break;
    }

    input.push(...toResponseInputItems(response.output));

    for (const toolCall of toolCalls) {
      log(
        `[tool] request name=${toolCall.name} call_id=${toolCall.call_id} arguments=${toolCall.arguments}`,
      );

      const outcome = runToolCall(catalog, toolCall.name, toolCall.arguments);
      const output = JSON.stringify(outcome);

      log(`[tool] result call_id=${toolCall.call_id} ${output}`);

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
  };
}
