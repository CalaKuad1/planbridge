# Contributing

Thanks for helping! A few ground rules keep PlanBridge simple and on the right side of Anthropic's terms:

1. **Zero runtime dependencies.** Node built-ins only.
2. **Personal-use guard rails stay.** Localhost by default, unmodified `claude` binary, never read or forward Claude credentials, no multi-user or resale features.
3. **Tests.** `npm test` must pass (unit tests, no Claude needed). If you touch the request flow, also run `npm run smoke` against a running server.
4. Keep the skill (`skills/planbridge/`) in sync with any API change.

Bug reports: please include `planbridge doctor` output.
