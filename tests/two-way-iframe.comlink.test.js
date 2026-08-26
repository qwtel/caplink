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

import { beforeEach, describe, expect, it } from "bun:test";

import * as Comlink from "../src/caplink.ts";
import { windowEndpoints } from "./fixtures/window.js";

describe("Comlink across iframes", function () {
  let parentEndpoint;
  let childEndpoint;

  beforeEach(function () {
    const { parentWindow, childWindow, parentEvents, childEvents } = windowEndpoints();
    parentEndpoint = Comlink.windowEndpoint(childWindow, parentEvents);
    childEndpoint = Comlink.windowEndpoint(parentWindow, childEvents);
  });

  it("can communicate both ways", async function () {
    let called = false;
    Comlink.expose((a) => {
      called = true;
      return ++a;
    }, parentEndpoint);
    const wrappedParent = Comlink.wrap(childEndpoint);
    Comlink.expose(async (a, b) => a + await wrappedParent(b), childEndpoint);
    const proxy = Comlink.wrap(parentEndpoint);
    expect(await proxy(1, 3)).toBe(5);
    expect(called).toBe(true);
    await proxy[Symbol.asyncDispose]();
    await wrappedParent[Symbol.asyncDispose]();
  });
});
