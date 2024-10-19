# Caplink

A modernized fork of [Comlink](https://github.com/GoogleChromeLabs/comlink) with many open PRs merged and the ability to use proxies as values in Caplink calls.  

```ts
// file: worker-1.ts
import * as Caplink from '@workers/caplink';
export class Greeter {
  helloWorld(name = "World") { 
    console.log(`Hello, ${name}!`);
  }
}
export class W1Fns {
  static newGreeter() {
    return Caplink.proxy(new Greeter());
  }
}
Caplink.expose(W1Fns);
```

```ts
// file: worker-2.ts
import * as Caplink from '@workers/caplink';
import type { Greeter } from "./worker-1.ts";

export class W2Fns {
  static async takeGreeter(greeter: Caplink.Remote<Greeter>) {
    using greeter_ = greeter; // can opt into explicit resource management
    await greeter_.helloWorld("Worker 2");
  } // local resources freed
}
Caplink.expose(W2Fns);

```

```ts
// file: index.ts
import * as Caplink from '@workers/caplink';
import type { W1Fns } from "./worker-1.ts";
import type { W2Fns } from "./worker-2.ts";

const w1 = Caplink.wrap<typeof W1Fns>(
  new Worker(new URL("./worker-1.ts", import.meta.url), { type: "module" }),
);
const w2 = Caplink.wrap<typeof W2Fns>(
  new Worker(new URL("./worker-2.ts", import.meta.url), { type: "module" }),
);

using remoteGreeter = await w1.newGreeter(); 
await remoteGreeter.helloWorld(); // logs "Hello, World" in w1.ts
await w2.takeGreeter(remoteGreeter);    // logs "Hello, Worker 2" in w1.ts
```
