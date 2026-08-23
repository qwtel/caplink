import { Worker } from "worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import * as Comlink from "../../src/caplink.ts";
import nodeEndpoint from "../../src/node-adapter.ts";

describe("node", () => {
  describe("Comlink across workers", function () {
    let worker;

    beforeEach(function () {
      worker = new Worker(new URL("./worker.mjs", import.meta.url));
    });

    afterEach(function () {
      worker.terminate();
    });

    it("can communicate", async function () {
      const proxy = Comlink.wrap(nodeEndpoint(worker));
      expect(await proxy(1, 3)).toBe(4);
    });

    it("can tunnels a new endpoint with createEndpoint", async function () {
      const proxy = Comlink.wrap(nodeEndpoint(worker));
      const otherEp = await proxy[Comlink.createEndpoint]();
      const otherProxy = Comlink.wrap(otherEp);
      expect(await otherProxy(20, 1)).toBe(21);
    });
  });
});
