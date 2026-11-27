import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import { createCatalog } from "../src/articles";
import {
  EXISTING_ARTICLE_MAX_OUTPUT_TOKENS,
  MAX_MODEL_CALLS,
  runExperiment,
  type ModelClient,
} from "../src/experiment";
import { runToolCall } from "../src/tools";

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
    assert.equal(result.draft, null);
    assert.equal(result.stoppedAtCallLimit, false);
    assert.equal(result.status, "completed");
    assert.equal(result.incompleteReason, null);

    const outputs = toolOutputs(requests[1]);
    assert.equal(outputs.length, 1);
    assert.deepEqual(outputs[0], {
      type: "function_call_output",
      call_id: "call_test_1",
      output: JSON.stringify(runToolCall(createCatalog(), "findArticle", rawArguments)),
    });

    assert.ok(lines.some((line) => line.includes("[tool] request") && line.includes("call_test_1")));
    assert.ok(lines.some((line) => line.includes("[tool] result") && line.includes("call_test_1")));
    assert.ok(lines.some((line) => line.includes("api_calls=2")));
  });

  it("stops at five model calls and does not execute a tool after the last one", async () => {
    const rawArguments = JSON.stringify({ slug: "beta-driven-development" });
    const callIds = ["call_1", "call_2", "call_3", "call_4", "call_5"];
    const { client, requests } = scriptedClient(callIds.map((callId) => functionCall(callId, rawArguments)));
    const lines: string[] = [];

    const result = await runExperiment({
      client,
      model: "test-model",
      prompt: "Keep looking",
      log: (line) => lines.push(line),
    });

    assert.equal(MAX_MODEL_CALLS, 5);
    assert.equal(requests.length, 5);
    assert.equal(result.apiCalls, 5);
    assert.equal(result.inputTokens, 55);
    assert.equal(result.outputTokens, 35);
    assert.equal(result.stoppedAtCallLimit, true);
    assert.ok(lines.some((line) => line.includes("[usage] api_calls=5 input_tokens=55 output_tokens=35")));

    const sentOnLastRequest = toolOutputs(requests[4]).map((item) =>
      "call_id" in item ? item.call_id : "",
    );
    assert.deepEqual(sentOnLastRequest, ["call_1", "call_2", "call_3", "call_4"]);
    for (const callId of ["call_1", "call_2", "call_3", "call_4"]) {
      assert.ok(lines.some((line) => line.includes("[tool] result") && line.includes(callId)));
    }
    assert.equal(
      lines.some((line) => line.includes("[tool] result") && line.includes("call_5")),
      false,
    );
    assert.ok(lines.some((line) => line.includes("did not execute call_id=call_5")));
    assert.equal(result.status, "completed");
    assert.equal(result.incompleteReason, null);
  });

  it("does not execute tool calls from an incomplete response", async () => {
    const { client, requests } = scriptedClient([
      functionCall("call_ok", JSON.stringify({ slug: "beta-driven-development" })),
      {
        id: "resp_incomplete",
        model: "provider/actual-model",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "function_call",
            call_id: "call_partial",
            name: "createDraft",
            arguments: JSON.stringify({
              slug: "office-notes",
              title: "Office Notes",
              summary: "A draft about the desk.",
            }),
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
      } as unknown as OpenAI.Responses.Response,
      message("This follow-up must not be requested."),
    ]);
    const lines: string[] = [];

    const result = await runExperiment({
      client,
      model: "provider/model-name",
      prompt: "Create a draft",
      log: (line) => lines.push(line),
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.max_output_tokens, 512);
    assert.equal(result.apiCalls, 2);
    assert.equal(result.status, "incomplete");
    assert.equal(result.incompleteReason, "max_output_tokens");
    assert.equal(result.stoppedAtCallLimit, false);
    assert.equal(result.finalText, "The model response was incomplete.");
    assert.ok(lines.some((line) => line.includes("[tool] result") && line.includes("call_ok")));
    assert.equal(
      lines.some((line) => line.includes("[tool] result") && line.includes("call_partial")),
      false,
    );
    assert.ok(lines.includes("[api] status=incomplete reason=max_output_tokens"));
    assert.ok(lines.includes("[incomplete] did not execute call_id=call_partial"));
  });

  it("records an unknown reason when an incomplete response omits one", async () => {
    const { client, requests } = scriptedClient([
      {
        id: "resp_incomplete",
        model: "provider/actual-model",
        status: "incomplete",
        output_text: "Partial answer",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: [{ type: "output_text", text: "Partial answer", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          total_tokens: 6,
        },
      } as unknown as OpenAI.Responses.Response,
    ]);

    const result = await runExperiment({
      client,
      model: "provider/model-name",
      prompt: "Say something",
      log: () => undefined,
    });

    assert.equal(requests.length, 1);
    assert.equal(result.status, "incomplete");
    assert.equal(result.incompleteReason, "unknown");
    assert.equal(result.finalText, "Partial answer");
    assert.equal(result.stoppedAtCallLimit, false);
  });

  it("parses an OpenRouter function call and sends the output with its call id", async () => {
    const rawArguments = JSON.stringify({ slug: "beta-driven-development" });
    const requestedModel = "provider/model-name";
    const { client, requests } = scriptedClient([
      {
        id: "resp_1234567890",
        model: "openai/gpt-4o-mini",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_abc123",
            call_id: "call_xyz789",
            name: "findArticle",
            arguments: rawArguments,
            status: "completed",
          },
        ],
        usage: {
          input_tokens: 45,
          output_tokens: 25,
          total_tokens: 70,
          cost: 0.0004,
        },
      } as unknown as OpenAI.Responses.Response,
      {
        id: "resp_final",
        model: "openai/gpt-4o-mini",
        status: "completed",
        output_text: "",
        output: [
          {
            type: "message",
            id: "msg_abc123",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "The catalog contains Beta-Driven Development.",
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 80,
          output_tokens: 12,
          total_tokens: 92,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
          cost: 0.0012,
        },
      } as unknown as OpenAI.Responses.Response,
    ]);
    const lines: string[] = [];

    const result = await runExperiment({
      client,
      model: requestedModel,
      prompt: "Look up beta-driven-development",
      log: (line) => lines.push(line),
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.model, requestedModel);
    assert.equal(requests[0]?.max_output_tokens, EXISTING_ARTICLE_MAX_OUTPUT_TOKENS);
    assert.equal(requests[0]?.store, false);
    assert.equal(requests[0]?.previous_response_id, undefined);
    assert.equal(result.finalText, "The catalog contains Beta-Driven Development.");
    assert.equal(result.inputTokens, 125);
    assert.equal(result.outputTokens, 37);

    assert.ok(Array.isArray(requests[1]?.input));
    const replayedCall = requests[1].input.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "function_call" &&
        "call_id" in item &&
        item.call_id === "call_xyz789",
    );
    assert.ok(replayedCall);
    assert.deepEqual(toolOutputs(requests[1]), [
      {
        type: "function_call_output",
        call_id: "call_xyz789",
        output: JSON.stringify(runToolCall(createCatalog(), "findArticle", rawArguments)),
      },
    ]);

    assert.ok(lines.includes("[api] model=openai/gpt-4o-mini"));
    assert.equal(
      lines.some((line) => line.includes(`[api] model=${requestedModel}`)),
      false,
    );
  });

  it("validates OpenRouter tool arguments before lookup", async () => {
    const { client, requests } = scriptedClient([
      {
        id: "resp_bad",
        model: "openai/gpt-4o-mini",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_bad",
            call_id: "call_bad",
            name: "findArticle",
            arguments: "not-json",
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
        },
      } as unknown as OpenAI.Responses.Response,
      message("The tool arguments were invalid."),
    ]);

    const result = await runExperiment({
      client,
      model: "provider/model-name",
      prompt: "Look up an article",
      log: () => undefined,
    });

    assert.equal(result.finalText, "The tool arguments were invalid.");
    assert.deepEqual(toolOutputs(requests[1]), [
      {
        type: "function_call_output",
        call_id: "call_bad",
        output: JSON.stringify({ ok: false, error: "Arguments are not valid JSON." }),
      },
    ]);
  });

  it("runs every function call in one completed response in order when parallel tool calls are off", async () => {
    const draft = {
      slug: "office-notes",
      title: "Office Notes",
      summary: "A draft about the desk.",
    };
    const lines: string[] = [];
    const { client, requests } = scriptedClient([
      {
        id: "resp_two",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_create",
            name: "createDraft",
            arguments: JSON.stringify(draft),
          },
          {
            type: "function_call",
            call_id: "call_update",
            name: "updateDraft",
            arguments: JSON.stringify({ ...draft, title: "Office Notes, revised" }),
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
      } as unknown as OpenAI.Responses.Response,
      message("Both tools ran."),
    ]);

    const result = await runExperiment({
      client,
      model: "provider/model-name",
      prompt: "Create a draft and revise its title",
      log: (line) => lines.push(line),
    });

    assert.equal(result.finalText, "Both tools ran.");
    assert.equal(requests[0]?.parallel_tool_calls, false);
    assert.equal(requests[0]?.max_output_tokens, EXISTING_ARTICLE_MAX_OUTPUT_TOKENS);
    assert.ok(lines.includes(`[api] max_output_tokens=${EXISTING_ARTICLE_MAX_OUTPUT_TOKENS}`));

    const outputs = toolOutputs(requests[1]);
    assert.equal(outputs.length, 2);
    const created = outputs[0];
    const updated = outputs[1];
    assert.ok(created && "call_id" in created && created.call_id === "call_create");
    assert.ok(updated && "call_id" in updated && updated.call_id === "call_update");
    assert.ok(created && "output" in created && typeof created.output === "string");
    assert.ok(updated && "output" in updated && typeof updated.output === "string");

    const createdResult = JSON.parse(created.output) as {
      ok: boolean;
      result?: { article?: { title?: string; body?: string; bodyStored?: boolean } };
    };
    const updatedResult = JSON.parse(updated.output) as {
      ok: boolean;
      result?: { article?: { title?: string; body?: string; bodyStored?: boolean } };
    };
    assert.equal(createdResult.ok, true);
    assert.equal(createdResult.result?.article?.body, undefined);
    assert.equal(createdResult.result?.article?.bodyStored, true);
    assert.equal(updatedResult.ok, true);
    assert.equal(updatedResult.result?.article?.title, "Office Notes, revised");
    assert.equal(updatedResult.result?.article?.bodyStored, true);
  });

  it("does not execute any function call when an incomplete response contains several", async () => {
    const lines: string[] = [];
    const { client, requests } = scriptedClient([
      {
        id: "resp_incomplete_many",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "function_call",
            call_id: "call_one",
            name: "createDraft",
            arguments: JSON.stringify({
              slug: "first-draft",
              title: "First",
              summary: "One",
            }),
          },
          {
            type: "function_call",
            call_id: "call_two",
            name: "createDraft",
            arguments: JSON.stringify({
              slug: "second-draft",
              title: "Second",
              summary: "Two",
            }),
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
      } as unknown as OpenAI.Responses.Response,
      message("This follow-up must not be requested."),
    ]);

    const result = await runExperiment({
      client,
      model: "provider/model-name",
      prompt: "Create two drafts",
      log: (line) => lines.push(line),
    });

    assert.equal(requests.length, 1);
    assert.equal(result.status, "incomplete");
    assert.equal(result.incompleteReason, "max_output_tokens");
    assert.equal(result.stoppedAtCallLimit, false);
    assert.ok(lines.includes("[incomplete] did not execute call_id=call_one"));
    assert.ok(lines.includes("[incomplete] did not execute call_id=call_two"));
    assert.equal(
      lines.some((line) => line.startsWith("[tool] result")),
      false,
    );
  });
});
