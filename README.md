# Caplink

Capability-oriented RPC for workers, windows, and message ports.

Caplink is a fork of [Comlink](https://github.com/GoogleChromeLabs/comlink). It keeps Comlink's small `expose()` / `wrap()` API while making remote functions and explicitly marked objects first-class capabilities: they can be passed as arguments, returned as results, forwarded through other realms, and restored to their original JavaScript identity when they come home.

It sits in the same object-capability family as [Cap'n Web](https://github.com/cloudflare/capnweb), but is a smaller step from Comlink. See [Relation to Cap'n Web](#relation-to-capn-web).

## Quick start

Expose an API in a worker:

```ts
// worker.ts
import * as Caplink from "@workers/caplink";

const api = {
  greet(name: string) {
    return `Hello, ${name}!`;
  },

  async run(callback: (message: string) => void) {
    await callback("Hello from the worker");
  },

  makeCounter() {
    return Caplink.proxy({
      value: 0,
      increment() {
        return ++this.value;
      },
    });
  },
};

export type Api = typeof api;
Caplink.expose(api);
```

Wrap it on the calling side:

```ts
// main.ts
import * as Caplink from "@workers/caplink";
import type { Api } from "./worker.ts";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

await using remote = Caplink.wrap<Api>(worker, undefined, { owned: true });
// Note: `owned: true` will terminate the worker when `remote` is disposed

console.log(await remote.greet("world"));

await remote.run((message) => console.log(message));

await using counter = await remote.makeCounter();
console.log(await counter.increment()); // 1
```

Every remote operation is asynchronous. TypeScript's `Remote<T>` mapping turns remote properties into promises and preserves function and constructor signatures.

## Values and capabilities

Caplink distinguishes copied values from capabilities:

- Structured-cloneable values are copied normally.
- Functions are capabilities automatically.
- Objects become capabilities when marked with `Caplink.proxy(object)`.
- `Caplink.transfer(value, transferables)` uses the platform transfer list
instead of copying the listed values.
- `Caplink.tuple(array)` and `Caplink.record(object)` clone the container while
applying Caplink's rules to its entries. This permits nested capabilities and
transferred values without proxying the whole container.

```ts
const result = Caplink.record({
  metadata: { source: "worker" },
  onChange: (value: number) => console.log(value),
});
```



## Capability identity

A capability has one identity in its owning realm. Sending the same capability more than once produces the same imported proxy while it remains live. If that capability is forwarded through another worker and later returned to its owner, Caplink restores the original function or object:

```ts
const callback = () => "local";
const returned = await remote.roundTrip(callback);

console.assert(returned === callback);
```

Identity belongs to the capability, not to the route it happened to take. Every capability is represented by its own `MessagePort`. Message ports remain the authority boundary; capability IDs are correlation metadata, not credentials.

## Endpoints

`expose(value, endpoint?)` serves a value through an endpoint. In a web worker, the endpoint defaults to `globalThis`.

`wrap<T>(endpoint, target?, options?)` returns a typed remote proxy. Set `owned: true` when disposing the proxy should also dispose or terminate the underlying endpoint.

Caplink works directly with browser `Worker` and `MessagePort` objects. Adapters cover other common transports.

### Node.js worker threads

```ts
import * as Caplink from "@workers/caplink";
import nodeEndpoint from "@workers/caplink/node-adapter";
import { parentPort } from "node:worker_threads";

Caplink.expose(api, nodeEndpoint(parentPort!));
```

Use the same adapter around a Node `Worker` before passing it to `wrap()`.

## API

- `expose(value, endpoint?, allowedOrigins?)` exposes a local API.
- `wrap<T>(endpoint, target?, options?)` creates a `Remote<T>`.
- `proxy(value)` marks an object as a capability. Functions need no marker.
- `transfer(value, transferables)` supplies a structured-clone transfer list.
- `tuple(value)` serializes each entry of an array or tuple independently.
- `record(value)` serializes each own enumerable entry independently.
- `windowEndpoint(window, context?, targetOrigin?)` adapts window messaging.
- `transferHandlers` is the registry for application-defined serialization.
- `Remote<T>` and `Local<T>` describe the two sides of a typed API.



## Compatibility

Caplink retains the Comlink protocol and its familiar API where practical. The test suite includes bidirectional interoperability coverage with Comlink 4.4.2, including values, transferables, errors, callbacks, capabilities, and constructors.

The important semantic differences are automatic function capabilities, explicit object capabilities, stable capability identity across forwarding, and deterministic disposal support.

## Relation to Cap'n Web

Caplink is a lesser version of that design. It does not implement promise pipelining, so a chain of dependent calls costs one round trip each. There is no `RpcPromise` stub for an unresolved result, no record-replay `.map()`, and no Cap'n Web session protocol. Every remote operation is an ordinary promise; you await it before using the result.

What Caplink keeps is a more natural progression from Comlink. The `expose()` / `wrap()` API, structured clone, transfer lists, and `MessagePort` transports. Each capability is its own `MessagePort` rather than an entry in a session import/export table, which tracks with [Ports as the basis of an object-capability model on the web](https://html.spec.whatwg.org/multipage/web-messaging.html#ports-as-the-basis-of-an-object-capability-model-on-the-web).

## Tests

Run the complete test suite with Bun:

```sh
bun test
```

