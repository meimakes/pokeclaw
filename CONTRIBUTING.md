# Contributing

Thanks for your interest in contributing to pokeclaw!

## Getting started

```bash
git clone https://github.com/meimakes/pokeclaw.git
cd pokeclaw
npm install
npm run dev
```

## Development workflow

1. Create a branch from `main`
2. Make your changes
3. Run checks: `npm run lint && npm run format:check && npm test`
4. Open a pull request

## Code style

- TypeScript strict mode
- Prettier for formatting (`npm run format`)
- ESLint for linting (`npm run lint:fix`)

## Tests

Tests use Node.js native `node:test`. Run with:

```bash
npm test
```

Add tests for new functionality in `src/*.test.ts` files.

## Reporting issues

Open an issue at https://github.com/meimakes/pokeclaw/issues with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS
