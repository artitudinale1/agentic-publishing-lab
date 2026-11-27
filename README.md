# Agentic Publishing Lab — Step 1

A minimal Node.js and TypeScript program that shows OpenAI function calling with the Responses API.

The only tool is a local mock, `findArticle(slug)`. The catalog contains one article, `beta-driven-development`. The program does not connect to a blog, Cloudinary, or any other service. Nothing in this step deploys, and the tests never call the API.

Running `npm start` is manual. Each run sends your prompt to OpenAI and can incur a small charge. It makes at most three Responses API calls.

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
│   ├── findArticleTool.ts   # strict tool schema, argument checks, local execution
│   ├── experiment.ts        # prompt → model → tool → model, with logs and limits
│   └── index.ts             # terminal entry; the only file that creates an OpenAI client
└── test/
    ├── findArticle.test.ts  # existing article, missing article, invalid arguments
    └── experiment.test.ts   # call id and the three-call limit, using a fake client
```

## Setup

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
OPENAI_API_KEY=your-real-key
OPENAI_MODEL=gpt-6.2-astra
```

`OPENAI_MODEL` is required. The example value matches the model name in the current Responses API quickstart. Use a model your key can access. `.env` is listed in `.gitignore`. `npm start` reads `.env` from the project directory when that file exists. Variables already set in the shell are left unchanged.

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

SDK retries are off (`maxRetries: 0`). Each response is capped at 256 output tokens. The loop stops after three model calls. If the third response is still a tool call, that result is logged and is not sent, because sending it would take a fourth call.

## Tests

```bash
npm test
npm run typecheck
```

`npm test` does not read `.env` and does not construct an OpenAI client. It checks the mock catalog, argument validation, and the call loop against a fake client.

## Stop

This repository is Step 1 only.
