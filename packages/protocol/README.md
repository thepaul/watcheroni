# @watcheroni/protocol

TypeScript types and constants for the
[watcheroni protocol](https://github.com/thepaul/watcheroni/blob/main/PROTOCOL.md):
the HTTP and WebSocket API a watcheroni server offers its clients. The
`watcheroni` CLI and server both use it; it's here for anyone writing
another client.

```
npm install @watcheroni/protocol
```

```ts
import { type ServerMessage, matchesKind } from "@watcheroni/protocol";

const socket = new WebSocket(url, "watcheroni.v1");
socket.onmessage = (message) => {
  const msg = JSON.parse(message.data) as ServerMessage;
  if (msg.type === "events") {
    for (const event of msg.events) {
      if (matchesKind(["check.*", "review.submitted"], event.kind)) console.log(event.kind, event.links.html);
    }
  }
};
```

It has the event shape (`WatchEvent`), the messages on an inbox's
WebSocket (`ClientMessage`, `ServerMessage`), the request and response
bodies (`Meta`, `LoginResponse`, `SubscriptionRequest` and so on), the
limits (`MAX_LIMIT`, `INBOX_MAX_EVENTS`, ...) and `matchesKind`, which
matches an event kind against patterns like `check.*`. PROTOCOL.md is the
contract; this package follows it. ES module only, no dependencies,
Node.js 22 or later (or any runtime with ES2022).

MIT licensed.
