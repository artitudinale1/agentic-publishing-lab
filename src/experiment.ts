import type OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { findArticleTool, runFindArticleCall } from "./findArticleTool";

/** Hard stop so a tool loop cannot keep calling the model. */
export const MAX_MODEL_CALLS = 3;

/** Visible reply plus tool-call JSON. Kept small on purpose. */
export const MAX_OUTPUT_TOKENS = 256;

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
};

type Log = (line: string) => void;

const INSTRUCTIONS = [
  "You answer questions about a small mock article catalog.",
  "Call findArticle whenever the user asks about an article.",
  "Use only the tool result. Do not invent articles.",
  "If the tool says the article is missing or the arguments are invalid, say that plainly.",
].join(" ");

function outputText(response: OpenAI.Responses.Response): string {
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
      tools: [findArticleTool],
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      store: false,
    });

    const usedInput = response.usage?.input_tokens ?? 0;
    const usedOutput = response.usage?.output_tokens ?? 0;
    inputTokens += usedInput;
    outputTokens += usedOutput;

    log(`[api] call ${callNumber} of ${MAX_MODEL_CALLS}`);
    log(`[api] input_tokens=${usedInput} output_tokens=${usedOutput}`);

    if (response.status === "incomplete") {
      log(`[api] incomplete reason=${response.incomplete_details?.reason ?? "unknown"}`);
    }

    const toolCalls = response.output.filter((item) => item.type === "function_call");

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
      };
    }

    input.push(...toResponseInputItems(response.output));

    const atLimit = callNumber === MAX_MODEL_CALLS;

    for (const toolCall of toolCalls) {
      log(
        `[tool] request name=${toolCall.name} call_id=${toolCall.call_id} arguments=${toolCall.arguments}`,
      );

      const outcome = runFindArticleCall(toolCall.name, toolCall.arguments);
      const output = JSON.stringify(outcome);

      log(`[tool] result call_id=${toolCall.call_id} ${output}`);

      if (atLimit) {
        stoppedAtCallLimit = true;
        log(
          `[limit] model call limit reached; tool result for ${toolCall.call_id} was not sent back`,
        );
        continue;
      }

      input.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output,
      });
    }

    if (atLimit) {
      finalText = outputText(response);
      break;
    }
  }

  log(
    `[usage] api_calls=${MAX_MODEL_CALLS} input_tokens=${inputTokens} output_tokens=${outputTokens}`,
  );

  if (!finalText) {
    finalText = "Stopped after 3 model calls before a final answer.";
  }

  return {
    apiCalls: MAX_MODEL_CALLS,
    inputTokens,
    outputTokens,
    finalText,
    stoppedAtCallLimit,
  };
}
