# MapAgent

MapAgent is an open-source chat agent that draws outdoor data on a Mapbox map. Ask a question in plain language, and the agent picks the right data layers (trails, peaks, water, and more) and shows them on the map. It runs on Next.js and works with Anthropic models or any OpenAI-compatible model.

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

## Adding layers

See [docs/layers.md](docs/layers.md) for how to add your own data layer.

## License

MIT
