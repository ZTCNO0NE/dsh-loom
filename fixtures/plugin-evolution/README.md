# Multi-plugin evolution fixture

This pair is intentionally incomplete at baseline. `dsh-loom-fixture-cost`
omits the model dimension and `dsh-loom-fixture-notify` cannot route on it.
The independent integration probe requires a coupled change:

1. preserve `model` in the cost event;
2. include it in the notification;
3. expose a `premium` or `priority` route for `deepseek-v4-flash`;
4. keep each package's build and focused tests green.

The fixture is a protocol/E2E asset, not a published package.
