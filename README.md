# Agentic Publishing Lab — Step 5B

A minimal Node.js and TypeScript program that shows function calling with the Responses API. It uses the official OpenAI SDK. Set `OPENAI_BASE_URL` to point that same client at OpenRouter.

The tools are `findArticle`, `createDraft`, and `updateDraft`. Each run gets its own in-memory catalog, seeded with the published article `beta-driven-development`. Articles now include a body. The model chooses which tools to call and in which order. The backend validates arguments and applies the catalog rules. There is no publish tool. The program does not connect to a blog, Cloudinary, or any other service, and the tests never call the API.

Running `npm start` is manual. Each run sends your prompt to the configured provider and can incur a small charge. It makes at most five Responses API calls. There is no fallback model.

## Project structure

```
agentic-publishing-lab/
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── articles.ts          # per-run catalog, including article body
│   ├── config.ts            # API key, model, optional base URL
│   ├── editorial.ts         # existing and generate modes, Markdown file loading
│   ├── tools.ts             # strict tool schemas, argument checks, backend execution
│   ├── experiment.ts        # prompt → model → whichever tool it requested → model
│   └── index.ts             # terminal entry; the only file that creates an OpenAI client
└── test/
    ├── config.test.ts       # official API and OpenRouter base URL
    ├── drafts.test.ts       # create, update, duplicates, and invalid draft arguments
    ├── editorial.test.ts    # supplied body, generated body, and invalid editorial input
    ├── fixtures/supplied-article.md
    ├── findArticle.test.ts  # existing article, missing article, invalid arguments
    └── experiment.test.ts   # call id, five-call limit, incomplete responses, OpenRouter fixtures
```

## Setup

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
```

Official OpenAI API:

```
OPENAI_API_KEY=your-real-key
OPENAI_MODEL=gpt-6.2-astra
```

OpenRouter, through the same SDK:

```
OPENAI_API_KEY=your-openrouter-key
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=openai/gpt-4o-mini
```

Leave `OPENAI_BASE_URL` unset for the official API. `OPENAI_MODEL` is required either way. Use a model your key can access. The samples above are configuration examples, not automatic substitutes.

OpenRouter's Responses API accepts the same function tools, `function_call` items, `call_id`s, and `function_call_output` items used here. It is stateless: `store: true` and `previous_response_id` are rejected, so each request sends `store: false` and the full input so far. Final text is read from message content of type `output_text`. The log line `[api] model=` is the model field returned by the provider.

`.env` is listed in `.gitignore`. `npm start` reads `.env` from the project directory when that file exists. Variables already set in the shell are left unchanged.

## Run the experiment

From the project directory:

```bash
npm start -- "Look up the article with slug beta-driven-development"
```

Or run `npm start` and type a prompt when asked.

Try a missing article:

```bash
npm start -- "Do you have an article called shipping-notes?"
```

The program will:

1. Read the prompt from the terminal.
2. Send it with the `findArticle`, `createDraft`, and `updateDraft` tool definitions. Tool choice stays on `auto`.
3. Print the function call the model returned.
4. Check the arguments locally.
5. Run that tool only when the arguments are valid and the catalog rule allows it. Creating a duplicate slug is rejected. Updating a missing or published article is rejected.
6. Send that result back with the model's `call_id`.
7. Print the model's short summary. When this run stored a draft, print that article from the catalog after the summary.

It also prints each tool request, each tool result, the API call count, and input and output tokens.

## Editorial modes

Editorial generation is the writing task. Agentic orchestration is the model deciding which catalog tools to call, and in which order. The backend still authorises every call. It does not ask the model to copy an existing article into the draft.

The instructions ask the model not to call `findArticle` immediately after a successful `createDraft`, unless the user explicitly asked to read the stored article. They also ask for a short completion summary instead of a copy of the article body. Tool choice stays on `auto`. The experiment result includes the last draft successfully created or updated in the run, copied from the catalog. The terminal prints that stored article, not text regenerated in the model's final reply.

### Existing article

The user supplies a Markdown file and publishing instructions. Optional context can be added. The model may propose a title, slug, and summary. `createDraft` does not accept a body argument. The backend attaches the file text, unchanged, to the new draft. A tool argument named `body` is rejected, and `updateDraft` cannot change the body either.

```bash
npm start -- --mode existing --file article.md --instructions "Propose a title, slug, and summary."
npm start -- --mode existing --file article.md --instructions "Propose a title, slug, and summary." --context "Audience is the lab."
```

### Generate article

The user supplies an editorial prompt, an optional length, and optional context. The model writes the article. `createDraft` requires slug, title, summary, and body. The backend stores that body only when every field is a non-empty string and the article is not longer than the selected maximum. It does not shorten the text.

`--length` accepts `short`, `medium`, or `long`. Omitting it selects medium. The word range is part of the editorial instructions. The backend picks the output-token budget from that same preset:

| Length | Words | Output tokens per call |
| --- | --- | --- |
| short | 150–300 | 2048 |
| medium | 300–600 | 4096 |
| long | 600–1000 | 8192 |

An article over the maximum is not stored. The tool result is `{ ok: false, error, validation }` with `validation.code` set to `too_long`, plus the length, the actual word count, and the maximum. The process logs `[article] length=...`, `[api] max_output_tokens=...`, and `[article] words=...`.

```bash
npm start -- --mode generate --prompt "Write about Beta the cat."
npm start -- --mode generate --prompt "Write about Beta the cat." --length short
npm start -- --mode generate --prompt "Write about Beta the cat." --length long --context "Mention resource acquisition."
```

Published articles still cannot be updated. Duplicate slugs are still rejected. Incomplete responses still do not execute tools. The five-call limit and disabled retries are unchanged.

`createDraft` and `updateDraft` results sent back to the model do not repeat the article body. They include slug, title, summary, category, status, and `bodyStored: true`. The catalog still keeps the complete body. `findArticle` returns that body.

### Validation

`validateArticle` checks a saved draft. It requires a title, slug, summary, and body. The slug must be lowercase letters, numbers, and single hyphens. The category must be `CODE`, `JAPANESE`, `CATS`, or `COOKING`. In existing-article mode the stored body must still match the supplied file. In generate-article mode the word count must fall inside the selected length preset. The tool result does not include the body.

Saving a draft does not require validation or approval. A failed check leaves the draft in memory and clears any earlier validation.

Pass `--category` when the editorial request should fix the category. `createDraft` must use that same value.

```bash
npm start -- --mode generate --prompt "Write about Beta the cat." --length short --category CATS
```

### Human approval

Approval is a backend operation. It is not a model tool, and this program does not ask for it on the command line. Approval is accepted only for a draft that `validateArticle` has accepted, and only for that exact revision. A later edit clears both validation and approval. Rejecting approval leaves the saved draft in place. The model cannot approve its own draft.

Publication is not available to the agent. Review and publication stay in the blog editor. This program never calls `publishPost` or `unpublishPost`.

### Blog persistence

`--target mock` is the default. The agent still edits the in-memory catalog, and a finished draft stays there.

`--target live` checks `BLOG_API_URL` and `AGENT_API_SECRET` before any model call. A missing value stops the run. The secret is sent only as `X-Agent-Authorization: Bearer <AGENT_API_SECRET>`.

After a completed run, the backend validates the final draft again. Invalid drafts and drafts from an unfinished run are not sent. Live mode then looks up the slug with `editorPosts`, including drafts, one page at a time. A failed or unfinished lookup is not treated as a missing article, and `createPost` is not called. An existing remote slug is left unchanged. A new draft is stored with `createPost`, the Markdown is sent unchanged, and the returned status must be `DRAFT`.

Each blog request has a 60 second timeout. A lookup may be tried once more after a network failure or a Render cold-start response. `createPost` is never retried. If that write does not finish, the result says the remote draft may or may not exist.

```bash
npm start -- --target mock --mode generate --prompt "Write about Beta the cat." --length short --category CATS
npm start -- --target live --mode generate --prompt "Write about Beta the cat." --length short --category CATS
```

Each request sets `parallel_tool_calls` to false, so the model is asked for one tool call. If a completed response still contains several function calls, the backend runs them in that order and returns each result with its own `call_id`. An incomplete response does not run any of them. The last of the five model calls does not run them either.

SDK retries are off (`maxRetries: 0`). Existing-article mode, and a run that is not an editorial generate request, caps each response at 512 output tokens. Generate-article mode uses 2048, 4096, or 8192 output tokens according to the length preset above. The process logs the limit it actually sends as `[api] max_output_tokens=...`. The loop stops after five model calls. If the fifth response is still a tool call, that call is logged and the tool is not executed, because sending the result would take a sixth model call. A response with status `incomplete` is also not used for tool execution. The terminal prints that status and the provider's reason, and the same fields are on the experiment result. Input and output tokens are logged for every response.

## Live OpenRouter observations

These are two successful manual runs against OpenRouter. They are observations from those runs, not a reliability benchmark.

The program keeps the conversation itself. Each request sends `store: false` and the input accumulated so far: the user prompt, the function call, and the function output. OpenRouter does not store that history, and the next call does not need to be the same model. The follow-up model sees the tool result because this process sends it, not because the provider remembered the previous model.

### Experiment 1 — existing article

Prompt asked for `beta-driven-development`. The article was returned.

| | |
|---|---|
| Models | Baidu ERNIE 5.5 Flash Preview, then NVIDIA Nemotron 3.5 Lightning |
| API calls | 2 |
| Input tokens | 698 |
| Output tokens | 121 |

### Experiment 2 — missing article

The reply reported that the article does not exist.

| | |
|---|---|
| Models | NVIDIA Nemotron 3.5 Lightning, then Baidu ERNIE 5.5 Flash Preview |
| API calls | 2 |
| Input tokens | 646 |
| Output tokens | 60 |

## Live multi-tool observations

These are manual OpenRouter runs of `findArticle`, `createDraft`, and `updateDraft`. They are observations from those runs, not a reliability benchmark.

### Published article protection

The model inspected `beta-driven-development` with `findArticle` and then chose not to call `updateDraft`. The published article stayed unchanged because no update was requested. This run did not exercise backend rejection. The deterministic tests still send a fake `updateDraft` for that published slug and require the backend to reject it.

## Live editorial observations

These are two manual runs after editorial modes were added. They are observations from those runs, not a reliability benchmark. The logs did not record model names or token totals for either run.

### Existing article

Existing-article mode was run with the local file `article.md`, "The Sacred Belly Protocol". The model was asked for metadata only. The backend attached the file body. That tool-call shape fits the 512 output-token cap, which stays the limit for this mode.

### Incomplete generation attempt

A generate-article run returned status `incomplete` with reason `max_output_tokens` while every mode still used the 512 output-token cap. The model had to write the article body inside the `createDraft` arguments, and that response did not finish. No tool call from the incomplete response was executed, so no generated draft was stored. Generate-article mode now selects 2048, 4096, or 8192 output tokens from the length preset. Existing-article mode remains at 512.

### Short article, 199 words

A generate-article run with the short length preset finished successfully. The stored article was 199 words. The run used 4 API calls, 8213 input tokens, and 1889 output tokens.

### Short article, 241 words

A later generate-article run with the short length preset finished successfully. The stored article was 241 words. The run used 3 API calls, 5064 input tokens, and 2258 output tokens.

The 199-word run used more API calls and more input tokens. The 241-word run used fewer calls and fewer input tokens, with more output tokens. Automatic model routing chooses the model for each call, so these runs were not held to one model. The figures are two observations. They are not a controlled performance comparison.

## Live validation observation

This is one successful manual generate-article run after `validateArticle` was added. It is an observation from that run, not a reliability benchmark.

The article was "Feline Cybersecurity", category `CODE`, 193 words. The model called `createDraft`, then `validateArticle`. It did not call `findArticle`. Validation succeeded. The article stayed a draft in memory. Creating that draft did not require human approval. The agent had no publication capability.

Duplicate protection was not exercised on this run because the model did not look up an existing slug and did not repeat one. The backend still rejects a duplicate slug. The deterministic tests still send a repeated slug and require that rejection.

| | |
|---|---|
| Article | Feline Cybersecurity |
| Category | CODE |
| Word count | 193 |
| API calls | 3 |
| Input tokens | 5033 |
| Output tokens | 1033 |
| Tool sequence | `createDraft`, `validateArticle` |

## Live blog integration

This is the first successful manual run that stored a validated draft through the blog GraphQL API. It is an observation from that run, not a reliability benchmark. `--target mock` remains the default. This run set `--target live`.

The article was "The Sacred Belly Protocol", in existing-article mode. The backend kept the supplied Markdown and stored the draft with `createPost`. The remote status was `DRAFT`. The draft was visible in the existing blog editor. The agent did not publish it.

| | |
|---|---|
| Article | The Sacred Belly Protocol |
| Mode | existing |
| Target | live |
| Slug | sacred-belly-protocol-lab |
| Category | CODE |
| Word count | 30 |
| API calls | 3 |
| Input tokens | 3370 |
| Output tokens | 526 |
| Tool sequence | `createDraft`, `validateArticle` |
| Remote status | DRAFT |

## Tests

```bash
npm test
npm run typecheck
```

`npm test` does not read `.env` and does not construct an OpenAI client. It checks the mock catalog, argument validation, provider settings, and the call loop against a fake client.

## Stop

This repository stops at Step 5B. Mock runs keep drafts in memory. Live runs can store a validated draft only. The agent cannot publish.
