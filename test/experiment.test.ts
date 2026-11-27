import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import { MAX_MODEL_CALLS, runExperiment, type ModelClient } from "../src/experiment";
import { runFindArticleCall } from "../src/findArticleTool";

/**
 * These tests use a fake client. They do not read an API key or call OpenAI.
 */

type CreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;

function functionCall(callId: string, rawArguments: string): OpenAI.Responses.Response {
  return {
    id: `resp_${callId}`,
    output_text: "",
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: callId,
        name: "findArticle",
        arguments: rawArguments,
      },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  } as unknown as OpenAI.Responses.Response;
}

function message(text: string): OpenAI.Responses.Response {
  return {
    id: "resp_final",
    output_text: text,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 20,
      output_tokens: 9,
      total_tokens: 29,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  } as unknown as OpenAI.Responses.Response;
}

function scriptedClient(responses: OpenAI.Responses.Response[]): {
  client: ModelClient;
  requests: CreateParams[];
} {
  const requests: CreateParams[] = [];
  let index = 0;

  const client: ModelClient = {
    responses: {
      create: async (params) => {
        requests.push(params);
        const next = responses[index];
        index += 1;

        if (!next) {
          throw new Error("The experiment made a model call the test did not expect.");
        }

        return next;
      },
    },
  };

  return { client, requests };
}

function toolOutputs(params: CreateParams | undefined) {
  assert.ok(Array.isArray(params?.input));
  return params.input.filter(
    (item) => typeof item === "object" && item !== null && "type" in item && item.type === "function_call_output",
  );
}

describe("runExperiment", () => {
  it("sends the tool result back with the model's call id", async () => {
    const rawArguments = JSON.stringify({ slug: "beta-driven-development" });
    const { client, requests } = scriptedClient([
      functionCall("call_test_1", rawArguments),
      message("Beta-Driven Development is in the mock catalog."),
    ]);
    const lines: string[] = [];

    const result = await runExperiment({
      client,
      model: "test-model",
      prompt: "Look up beta-driven-development",
      log: (line) => lines.push(line),
    });

    assert.equal(requests.length, 2);
    assert.equal(result.apiCalls, 2);
    assert.equal(result.inputTokens, 31);
    assert.equal(result.outputTokens, 16);
    assert.equal(result.finalText, "Beta-Driven Development is in the mock catalog.");
    assert.equal(result.stoppedAtCallLimit, false);

    const outputs = toolOutputs(requests[1]);
    assert.equal(outputs.length, 1);
    assert.deepEqual(outputs[0], {
      type: "function_call_output",
      call_id: "call_test_1",
      output: JSON.stringify(runFindArticleCall("findArticle", rawArguments)),
    });

    assert.ok(lines.some((line) => line.includes("[tool] request") && line.includes("call_test_1")));
    assert.ok(lines.some((line) => line.includes("[tool] result") && line.includes("call_test_1")));
    assert.ok(lines.some((line) => line.includes("api_calls=2")));
  });

  it("stops at three model calls and does not send a fourth", async () => {
    const rawArguments = JSON.stringify({ slug: "beta-driven-development" });
    const { client, requests } = scriptedClient([
      functionCall("call_1", rawArguments),
      functionCall("call_2", rawArguments),
      functionCall("call_3", rawArguments),
    ]);

    const result = await runExperiment({
      client,
      model: "test-model",
      prompt: "Keep looking",
      log: () => undefined,
    });

    assert.equal(MAX_MODEL_CALLS, 3);
    assert.equal(requests.length, 3);
    assert.equal(result.apiCalls, 3);
    assert.equal(result.stoppedAtCallLimit, true);

    const sentOnThirdRequest = toolOutputs(requests[2]).map((item) =>
      "call_id" in item ? item.call_id : "",
    );
    assert.deepEqual(sentOnThirdRequest, ["call_1", "call_2"]);
  });
});
