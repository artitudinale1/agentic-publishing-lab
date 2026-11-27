# Agentic Publishing Lab — Step 1

A minimal Node.js and TypeScript program that shows function calling with the Responses API. It uses the official OpenAI SDK. Set `OPENAI_BASE_URL` to point that same client at OpenRouter.

The only tool is a local mock, `findArticle(slug)`. The catalog contains one article, `beta-driven-development`. The program does not connect to a blog, Cloudinary, or any other service. Nothing in this step deploys, and the tests never call the API.

Running `npm start` is manual. Each run sends your prompt to the configured provider and can incur a small charge. It makes at most three Responses API calls. There is no fallback model.

## Project structure

```
agentic-publishing-lab/
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── articles.ts          # mock catalog and findArticle
│   ├── config.ts            # API key, model, optional base URL
│   ├── findArticleTool.ts   # strict tool schema, argument checks, local execution
│   ├── experiment.ts        # prompt → model → tool → model, with logs and limits
│   └── index.ts             # terminal entry; the only file that creates an OpenAI client
└── test/
    ├── config.test.ts       # official API and OpenRouter base URL
    ├── findArticle.test.ts  # existing article, missing article, invalid arguments
    └── experiment.test.ts   # call id, limits, and OpenRouter response fixtures
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
2. Send it with the `findArticle` tool definition.
3. Print the function call the model returned.
4. Check the arguments locally.
5. Run `findArticle` only when the arguments are valid.
6. Send that result back with the model's `call_id`.
7. Print the model's final text.

It also prints each tool request, each tool result, the API call count, and input and output tokens.

SDK retries are off (`maxRetries: 0`). Each response is capped at 256 output tokens. The loop stops after three model calls. If the third response is still a tool call, that call is logged and the tool is not executed, because sending the result would take a fourth model call.

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

## Tests

```bash
npm test
npm run typecheck
```

`npm test` does not read `.env` and does not construct an OpenAI client. It checks the mock catalog, argument validation, provider settings, and the call loop against a fake client.

## Stop

This repository is Step 1 only.
