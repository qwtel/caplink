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

import { describe, expect, it } from "bun:test";

import * as Comlink from "../src/caplink.ts";
import { controlledEndpoint } from "./fixtures/window.js";

const nextTask = () => new Promise((resolve) => setTimeout(resolve));
const setMessage = (id, value) => ({
  id,
  type: "SET",
  path: ["my"],
  value: { type: "RAW", value },
});

describe("Comlink origin filtering", function () {
  it("rejects messages from unknown origin", async function () {
    const obj = { my: "value" };
    const { endpoint, receive, sent } = controlledEndpoint();
    Comlink.expose(obj, endpoint, [/^http:\/\/localhost(:[0-9]+)?\/?$/]);

    receive(setMessage(1, "x"), "null");
    await nextTask();

    expect(obj.my).toBe("value");
    expect(sent).toHaveLength(0);
    receive({ id: 2, type: "RELEASE" }, "http://localhost");
    await nextTask();
  });

  it("accepts messages from matching origin", async function () {
    const obj = { my: "value" };
    const { endpoint, receive, sent } = controlledEndpoint();
    Comlink.expose(obj, endpoint, [/^http:\/\/localhost(:[0-9]+)?\/?$/]);

    receive(setMessage(1, "x"), "http://localhost");
    await nextTask();

    expect(obj.my).toBe("x");
    expect(sent.at(-1)).toMatchObject({ id: 1, type: "RAW", value: true });
    receive({ id: 2, type: "RELEASE" }, "http://localhost");
    await nextTask();
  });
});
