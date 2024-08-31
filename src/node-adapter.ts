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
  on(type: string, listener: (value: any) => void): void;
  off(type: string, listener: (value: any) => void): void;
  start?: () => void;
}

const mkl = (eh: EventListenerOrEventListenerObject) => (data: any) => {
  if ("handleEvent" in eh) {
    eh.handleEvent({ data } as MessageEvent); // XXX: doesn't work for non-MessageEvent
  } else {
    eh({ data } as MessageEvent); // XXX: doesn't work for non-MessageEvent
  }
};

export default function nodeEndpoint(nep: Endpoint|NodeEndpoint): Endpoint {
  if (!('on' in nep) || !('off' in nep)) return nep;
  const listeners = new WeakMap();
  return {
    postMessage: nep.postMessage.bind(nep),
    addEventListener: (name: string, eh: EventListenerOrEventListenerObject) => {
      const l = mkl(eh);
      nep.on(name, l);
      listeners.set(eh, l);
    },
    removeEventListener: (name: string, eh: EventListenerOrEventListenerObject) => {
      const l = listeners.get(eh);
      if (!l) return;
      nep.off(name, l);
      listeners.delete(eh);
    },
    ...nep.start && { start: nep.start.bind(nep) },
  };
}
