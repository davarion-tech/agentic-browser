# Contributing

Thanks for helping give agents better wings.

1. Fork the repo and create a branch.
2. `npm install`, then `npm run doctor` to check your environment.
3. Make your change. Keep tool output compact, because every character becomes an agent token.
4. Run `npm test`. The end-to-end test drives a real headless Chrome against `test/page.html`. Add a check there for any new behavior.
5. Open a pull request that describes the problem, the fix, and the effect on tokens if any.

Guidelines:

- New tools need a clear `description` (agents read it to decide when to call the tool) and a zod `schema`.
- Anything that changes a page must be added to `MUTATING` in `src/tools.js`, so that `AGENT_READONLY=1` blocks it.
- We will not accept features whose purpose is evading bot detection, solving CAPTCHAs, or bypassing site protections. See [DISCLAIMER.md](DISCLAIMER.md).
- Report security issues privately. See [SECURITY.md](SECURITY.md).
