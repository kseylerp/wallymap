# MapAgent

MapAgent is an open-source chat agent that draws outdoor data on a Mapbox map. Ask a question in plain language, and the agent picks the right data layers (trails, peaks, water, and more) and shows them on the map. It runs on Next.js, and you bring your own model: OpenRouter, Anthropic directly, or any OpenAI-compatible server.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/REPO_OWNER/mapagent)

## Quickstart

```bash
git clone https://github.com/REPO_OWNER/mapagent.git
cd mapagent
cp .env.example .env.local
pnpm i
pnpm dev
```

Then open http://localhost:3000. Fill in `.env.local` first; each variable in `.env.example` has a comment explaining what it unlocks.

## Environment variables

Copy `.env.example` to `.env.local` and fill in what you need.

| Name | Required? | What it unlocks | Where to get it |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Yes | The map itself | [mapbox.com](https://account.mapbox.com/access-tokens/) |
| `MAPBOX_TOKEN` | No | Server-side place search (falls back to the public token) | [mapbox.com](https://account.mapbox.com/access-tokens/) |
| `MODEL_NAME` | Yes | Picks the model the agent uses | Your provider's model list |
| `MODEL_PROVIDER` | No | `openrouter` (default), `anthropic`, or `openai-compatible` | n/a |
| `OPENROUTER_API_KEY` | For the default provider | The chat agent via OpenRouter | [openrouter.ai](https://openrouter.ai/keys) |
| `ANTHROPIC_API_KEY` | When `MODEL_PROVIDER=anthropic` | The chat agent via Anthropic | [console.anthropic.com](https://console.anthropic.com/) |
| `OPENAI_COMPATIBLE_BASE_URL` | When `MODEL_PROVIDER=openai-compatible` | A local or third-party model server | Your server (for example `http://localhost:11434/v1`) |
| `OPENAI_COMPATIBLE_API_KEY` | No | Authenticated third-party endpoints | Your provider |
| `OVERPASS_URL` | No | Your own Overpass server for trails (a public one is the default) | [wiki.openstreetmap.org](https://wiki.openstreetmap.org/wiki/Overpass_API) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | No | Response caching and rate limiting | Vercel KV |
| `NEXT_PUBLIC_NATURAL_EARTH_STYLE` | No | Natural Earth basemap (Milestone 3) | Mapbox Studio |

## Bring your own key and model

MapAgent never picks a model for you. Set `MODEL_NAME` and the key for your provider.

**OpenRouter (default).** Set `OPENROUTER_API_KEY` and any OpenRouter model slug:

```bash
MODEL_NAME=anthropic/claude-haiku-5.5
# or
MODEL_NAME=qwen/qwen3-235b-a22b-2507
```

**Anthropic directly.**

```bash
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
MODEL_NAME=<an Anthropic model id>
```

**Any OpenAI-compatible server (Ollama, vLLM, and others).**

```bash
MODEL_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
MODEL_NAME=<the model name your server serves>
```

The model must support tool calling.

## Before you deploy publicly

Anyone who can reach your deployment can chat with the agent, and every message spends your model credits. Turn on [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection) (a password, or Vercel Authentication) before you share the URL. The chat endpoint also rejects requests with more than 40 messages or a body over 256 KB, but that only limits the size of each request, not how many are sent.

## Tests

- `pnpm test` runs the unit tests. It needs no keys and no network.
- `pnpm e2e` runs the browser tests with Playwright. The page-load test always runs; the test that asks the agent a question is skipped unless `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` is set.

## Add a layer

See [docs/layers.md](docs/layers.md) for how to add your own data layer. The six starter questions and the tool calls expected for each are in [docs/questions.md](docs/questions.md).

## Milestone 1 and what is next

**In Milestone 1:** a Mapbox globe, a chat agent that can search places, move the map, and draw layers, the OpenStreetMap trails layer, and a provider switch for your own model.

**Next:** forest loss, fire, snow, and water layers; popularity and remoteness scores; 3D columns; a time scrubber; and route profiles.

## License

MIT
