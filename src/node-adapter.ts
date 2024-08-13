/**
 * Provides a Caplink adapter for Node.js WebWorker endpoints.
 * @module
 * 
 * @example
 * ```ts
 * import { expose } from "@workers/caplink";
 * import { nodeEndpoint } from "@workers/caplink/node-adapter";
 * import { parentPort } from "node:worker_threads";
 * expose({ fn() {} }, nodeEndpoint(parentPort))
 * ```
 */

/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Endpoint } from "./protocol.ts";

export interface NodeEndpoint {
  postMessage(message: any, transfer?: any[]): void;
  on(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: {}
  ): void;
  off(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: {}
  ): void;
  start?: () => void;
}

export default function nodeEndpoint(nep: Endpoint|NodeEndpoint): Endpoint {
  if (!('on' in nep) || !('off' in nep)) return nep;
  const listeners = new WeakMap();
  return {
    postMessage: nep.postMessage.bind(nep),
    addEventListener: (_: string, eh: any) => {
      const l = (data: any) => {
        if ("handleEvent" in eh) {
          eh.handleEvent({ data } as MessageEvent);
        } else {
          eh({ data } as MessageEvent);
        }
      };
      nep.on("message", l);
      listeners.set(eh, l);
    },
    removeEventListener: (_: string, eh: any) => {
      const l = listeners.get(eh);
      if (!l) {
        return;
      }
      nep.off("message", l);
      listeners.delete(eh);
    },
    start: nep.start && nep.start.bind(nep),
  };
}
