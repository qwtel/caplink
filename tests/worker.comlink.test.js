/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import * as Comlink from "../src/caplink.ts";

describe("Comlink across workers", function () {
  let worker;

  beforeEach(function () {
    worker = new Worker(new URL("./fixtures/worker.js", import.meta.url), {
      type: "module",
    });
  });

  afterEach(function () {
    worker.terminate();
  });

  it("can communicate", async function () {
    const proxy = Comlink.wrap(worker);
    expect(await proxy(1, 3)).toBe(4);
  });

  it("restores a capability passed back to its owning worker", async function () {
    const proxy = Comlink.wrap(worker);
    const capability = await proxy.capability();
    expect(await proxy.isOriginal(capability)).toBe(true);
    await capability[Symbol.asyncDispose]();
  });

  it("can tunnels a new endpoint with createEndpoint", async function () {
    const proxy = Comlink.wrap(worker);
    const otherEp = await proxy[Comlink.createEndpoint]();
    const otherProxy = Comlink.wrap(otherEp);
    expect(await otherProxy(20, 1)).toBe(21);
  });
});
