import { parentPort } from "worker_threads";
import * as Comlink from "../../src/caplink.ts";
import nodeEndpoint from "../../src/node-adapter.ts";

Comlink.expose((a, b) => a + b, nodeEndpoint(parentPort));
