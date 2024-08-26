/**
 * A modernized fork of [Comlink](https://github.com/GoogleChromeLabs/comlink) with many open PRs merged 
 * and the ability to use proxies as values in Caplink calls.  
 * @module
 */

/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Endpoint,
  MessageEventTarget,
  Message,
  MessageType,
  PostMessageWithOrigin,
  WireValue,
  WireValueType,
  MessageId,
  messageChannel,
  toNative,
  adoptNative,
} from "./protocol.ts";

export type { Endpoint, MessageEventTarget, PostMessageWithOrigin };

export const proxyMarker = Symbol("Caplink.proxy");
export const createEndpoint = Symbol("Caplink.endpoint");
/** @deprecated Use `Symbol.dispose` or `Symbol.asyncDispose` instead */
export const releaseProxy = Symbol("Caplink.releaseProxy");
/** @deprecated Use `Symbol.dispose` or `Symbol.asyncDispose` instead */
export const finalizer = Symbol("Caplink.finalizer");
export { messageChannel, toNative, adoptNative };

const throwMarker = Symbol("Caplink.thrown");

/**
 * Interface of values that were marked to be proxied with `caplink.proxy()`.
 * Can also be implemented by classes.
 */
export interface ProxyMarked {
  [proxyMarker]: true;
}

/**
 * Interface for our own proxy objects. The defining characteristic is the ability to get the underlying message port.
 */
interface Proxy {
  [createEndpoint](): MessagePort
}

/**
 * Takes a type and wraps it in a Promise, if it not already is one.
 * This is to avoid `Promise<Promise<T>>`.
 *
 * This is the inverse of `Unpromisify<T>`.
 */
type Promisify<T> = T extends PromiseLike<unknown> ? T : Promise<T>;

/**
 * Takes the raw type of a remote property and returns the type that is visible to the local thread on the proxy.
 *
 * Note: This needs to be its own type alias, otherwise it will not distribute over unions.
 * See https://www.typescriptlang.org/docs/handbook/advanced-types.html#distributive-conditional-types
 */
type RemoteProperty<T> =
  // If the value is a function, caplink will proxy it automatically.
  // Objects are only proxied if they are marked to be proxied.
  // Otherwise, the property is converted to a Promise that resolves the cloned value.
  T extends Function | ProxyMarked ? Remote<T> : Promisify<T>;

/**
 * Takes the raw type of a property as a remote thread would see it through a proxy (e.g. when passed in as a function
 * argument) and returns the type that the local thread has to supply.
 *
 * This is the inverse of `RemoteProperty<T>`.
 *
 * Note: This needs to be its own type alias, otherwise it will not distribute over unions. See
 * https://www.typescriptlang.org/docs/handbook/advanced-types.html#distributive-conditional-types
 */
type LocalProperty<T> = T extends Function | ProxyMarked
  ? Local<T>
  : Awaited<T>;

/**
 * Proxies `T` if it is a `ProxyMarked`, clones it otherwise (as handled by structured cloning and transfer handlers).
 */
export type ProxyOrClone<T> = T extends ProxyMarked ? Remote<T> : T;
/**
 * Inverse of `ProxyOrClone<T>`.
 */
export type UnproxyOrClone<T> = T extends Remote<infer U>
  ? U & ProxyMarked | Remote<U>
  : T extends RemoteObject<ProxyMarked>
  ? Local<T>
  : T;

/**
 * Takes the raw type of a remote object in the other thread and returns the type as it is visible to the local thread
 * when proxied with `Caplink.proxy()`.
 *
 * This does not handle call signatures, which is handled by the more general `Remote<T>` type.
 *
 * @template T The raw type of a remote object as seen in the other thread.
 */
export type RemoteObject<T> = { [P in keyof T as Exclude<P, symbol>]: RemoteProperty<T[P]> };
/**
 * Takes the type of an object as a remote thread would see it through a proxy (e.g. when passed in as a function
 * argument) and returns the type that the local thread has to supply.
 *
 * This does not handle call signatures, which is handled by the more general `Local<T>` type.
 *
 * This is the inverse of `RemoteObject<T>`.
 *
 * @template T The type of a proxied object.
 */
export type LocalObject<T> = { [P in keyof T]: LocalProperty<T[P]> };

/**
 * Additional special caplink methods available on each proxy returned by `Caplink.wrap()`.
 */
export interface ProxyMethods {
  [createEndpoint]: () => MessagePort;
  [Symbol.dispose]: () => void;
  [Symbol.asyncDispose]: () => Promise<void>;
  /** @deprecated Use `Symbol.dispose` or `Symbol.asyncDispose` instead */
  [releaseProxy]: () => Promise<void>;
}

/**
 * Takes the raw type of a remote object, function or class in the other thread and returns the type as it is visible to
 * the local thread from the proxy return value of `Caplink.wrap()` or `Caplink.proxy()`.
 */
export type Remote<T> =
  // Handle properties
  RemoteObject<T> &
    // Handle call signature (if present)
    (T extends (...args: infer TArguments) => infer TReturn
      ? (
          ...args: { [I in keyof TArguments]: UnproxyOrClone<TArguments[I]> }
        ) => Promisify<ProxyOrClone<Awaited<TReturn>>>
      : unknown) &
    // Handle construct signature (if present)
    // The return of construct signatures is always proxied (whether marked or not)
    (T extends { new (...args: infer TArguments): infer TInstance }
      ? {
          new (
            ...args: {
              [I in keyof TArguments]: UnproxyOrClone<TArguments[I]>;
            }
          ): Promisify<Remote<TInstance>>;
        }
      : unknown) &
    // Include additional special caplink methods available on the proxy.
    ProxyMethods;

/**
 * Expresses that a type can be either a sync or async.
 */
type MaybePromise<T> = PromiseLike<T> | T;

/**
 * Takes the raw type of a remote object, function or class as a remote thread would see it through a proxy (e.g. when
 * passed in as a function argument) and returns the type the local thread has to supply.
 *
 * This is the inverse of `Remote<T>`. It takes a `Remote<T>` and returns its original input `T`.
 */
export type Local<T> =
  // Omit the special proxy methods (they don't need to be supplied, caplink adds them)
  Omit<LocalObject<T>, keyof ProxyMethods> &
    // Handle call signatures (if present)
    (T extends (...args: infer TArguments) => infer TReturn
      ? (
          ...args: { [I in keyof TArguments]: ProxyOrClone<TArguments[I]> }
        ) => // The raw function could either be sync or async, but is always proxied automatically
        MaybePromise<UnproxyOrClone<Awaited<TReturn>>>
      : unknown) &
    // Handle construct signature (if present)
    // The return of construct signatures is always proxied (whether marked or not)
    (T extends { new (...args: infer TArguments): infer TInstance }
      ? {
          new (
            ...args: {
              [I in keyof TArguments]: ProxyOrClone<TArguments[I]>;
            }
          ): // The raw constructor could either be sync or async, but is always proxied automatically
          MaybePromise<Local<Awaited<TInstance>>>;
        }
      : unknown);

const isObject = (val: unknown): val is object => typeof val === "object" && val !== null;
const isReceiver = (val: unknown): val is object|Function =>
  (typeof val === "object" && val !== null) || typeof val === "function";

type TransferableTuple<T> = [value: T, transfer: Transferable[]];

/**
 * Customizes the serialization of certain values as determined by `canHandle()`.
 *
 * @template T The input type being handled by this transfer handler.
 * @template S The serialized type sent over the wire.
 */
export interface TransferHandler<T extends object|Function, S> {
  /**
   * Gets called for every value to determine whether this transfer handler
   * should serialize the value, which includes checking that it is of the right
   * type (but can perform checks beyond that as well).
   */
  canHandle(value: object|Function, ep: Endpoint): value is T;

  /**
   * Gets called with the value if `canHandle()` returned `true` to produce a
   * value that can be sent in a message, consisting of structured-cloneable
   * values and/or transferrable objects.
   */
  serialize(value: T, ep: Endpoint): TransferableTuple<S>;

  /**
   * Gets called to deserialize an incoming value that was serialized in the
   * other thread with this transfer handler (known through the name it was
   * registered under).
   */
  deserialize(value: S, ep: Endpoint): T;
}

const isNativeEndpoint = (x: unknown): x is Worker|MessagePort => {
  return ('Worker' in globalThis && x instanceof globalThis.Worker) || ('MessagePort' in globalThis && x instanceof globalThis.MessagePort);
}
const isNativeConvertible = (x: unknown): x is { [toNative](): MessagePort } => {
  return isReceiver(x) && toNative in x;
}

/**
 * Internal transfer handle to handle objects marked to proxy.
 */
const proxyTransferHandler = {
  canHandle: (val): val is Proxy|ProxyMarked => proxyMarker in val || createEndpoint in val,
  serialize(obj, ep) {
    let port;
    if (createEndpoint in obj) {
      port = obj[createEndpoint]();
      if (isNativeEndpoint(ep) && isNativeConvertible(port)) {
        port = port[toNative]();
      } else if (ep[adoptNative] && isNativeEndpoint(port)) {
        port = ep[adoptNative](port);
      }
    } else {
      const { port1, port2 } = new (ep[messageChannel] ?? MessageChannel)();
      expose(obj, port1);
      port = port2;
    }
    return [port, [port]];
  },
  deserialize(port) {
    port.start();
    return wrap(port);
  },
} satisfies TransferHandler<Proxy|ProxyMarked, MessagePort>;

interface ThrownValue {
  [throwMarker]: unknown; // just needs to be present
  value: unknown;
}

type ResolversMap<K, V> = Map<K, Omit<PromiseWithResolvers<V>, 'promise'>>;

interface EndpointState { 
  readonly resolvers: ResolversMap<MessageId, WireValue>;
  readonly messageHandler: (ev: MessageEvent<WireValue|null>) => void;
};

const endpointState = new WeakMap<Endpoint, EndpointState>;

/**
 * Internal transfer handler to handle thrown exceptions.
 */
const throwTransferHandler = {
  canHandle: (value): value is ThrownValue => throwMarker in value,
  serialize({ value }) {
    return [value, []];
  },
  deserialize(value: unknown) {
    throw value;
  },
} satisfies TransferHandler<ThrownValue, any>;

/**
 * Allows customizing the serialization of certain values.
 */
export const transferHandlers: Map<
  string,
  TransferHandler<object|Function, unknown>
> = new Map<string, any>([
  ["proxy", proxyTransferHandler],
  ["throw", throwTransferHandler],
]);

function isAllowedOrigin(
  allowedOrigins: (string | RegExp)[],
  origin: string
): boolean {
  for (const allowedOrigin of allowedOrigins) {
    if (origin === allowedOrigin || allowedOrigin === "*") {
      return true;
    }
    if (allowedOrigin instanceof RegExp && allowedOrigin.test(origin)) {
      return true;
    }
  }
  return false;
}

function isOurMessage(val: unknown): val is Message {
  return isObject(val) && "type" in val && "id" in val;
}

/** Keeping track of how many times an object was exposed. */
const objectCounter = new WeakMap<object, number>();

/** Decrease an exposed objects's ref counter and potentially run its cleanup code. */
async function finalizeObject(obj: any) {
  const newCount = (objectCounter.get(obj) || 0) - 1;
  objectCounter.set(obj, newCount);
  if (newCount === 0) {
    // Run finalizers before sending message so caller can be sure that resources are freed up
    if ('dispose' in Symbol && Symbol.dispose in obj) {
      obj[Symbol.dispose]();
    }
    if ('asyncDispose' in Symbol && Symbol.asyncDispose in obj) {
      await obj[Symbol.asyncDispose]();
    }
    if (finalizer in obj && typeof obj[finalizer] === "function") {
      obj[finalizer]();
    }
  }
}

const locked = new WeakSet<Endpoint>
export function expose(
  object: object,
  ep: Endpoint = globalThis as any,
  allowedOrigins: (string | RegExp)[] = ["*"]
) {
  if (locked.has(ep)) throw Error("Endpoint is already exposing another object and cannot be reused.");
  locked.add(ep);
  objectCounter.set(object, (objectCounter.get(object) || 0) + 1);
  ep.addEventListener("message", async function callback(ev: MessageEvent<unknown>): Promise<void> {
    const obj = object as any;
    if (!ev || !ev.data || !isOurMessage(ev.data)) {
      return;
    }
    if (!isAllowedOrigin(allowedOrigins, ev.origin)) {
      console.warn(`Invalid origin '${ev.origin}' for caplink proxy`);
      return;
    }
    const { data } = ev;
    const { id, type } = data;
    let returnValue;
    try {
      switch (type) {
        case MessageType.GET:
          {
            const rawValue = data.path.reduce((obj, prop) => obj[prop], obj);
            returnValue = rawValue;
          }
          break;
        case MessageType.SET:
          {
            const parent = data.path.slice(0, -1).reduce((obj, prop) => obj[prop], obj);
            parent[data.path.slice(-1)[0]] = fromWireValue.call(ep, data.value);
            returnValue = true;
          }
          break;
        case MessageType.APPLY:
          {
            const parent = data.path.slice(0, -1).reduce((obj, prop) => obj[prop], obj);
            const rawValue = data.path.reduce((obj, prop) => obj[prop], obj);
            const argumentList = data.argumentList.map(fromWireValue, ep);
            returnValue = rawValue.apply(parent, argumentList);
          }
          break;
        case MessageType.CONSTRUCT:
          {
            const rawValue = data.path.reduce((obj, prop) => obj[prop], obj);
            const argumentList = data.argumentList.map(fromWireValue, ep);
            const value = new rawValue(...argumentList);
            returnValue = proxy(value);
          }
          break;
        case MessageType.ENDPOINT:
          {
            expose(obj, data.value);
            returnValue = undefined;
          }
          break;
        case MessageType.RELEASE:
          {
            returnValue = undefined;
            finalizeObject(obj);
          }
          break;
        default:
          return;
      }
    } catch (value) {
      returnValue = { value, [throwMarker]: 0 };
    }
    try {
      returnValue = await returnValue;
    } catch (value) {
      returnValue = { value, [throwMarker]: 0 };
    }
    {
      try {
        const [wireValue, transfer] = toWireValue.call(ep, returnValue);
        wireValue.id = id;
        // @ts-ignore
        (ev.source ?? ep).postMessage(wireValue, { transfer });
      }
      catch (err) {
        console.error(err)
        // Send Serialization Error To Caller
        const [wireValue, transfer] = toWireValue.call(ep, {
          value: new TypeError("Unserializable return value"),
          [throwMarker]: 0,
        });
        wireValue.id = id;
        // @ts-ignore
        (ev.source ?? ep).postMessage(wireValue, { transfer });
      }
      finally {
        if (type === MessageType.RELEASE) {
          // detach and deactivate after sending release response above.
          ep.removeEventListener("message", callback);
          ep.removeEventListener("close", listener);
          ep.removeEventListener("error", listener);
          closeEndpoint(ep);
        }
      }
    }
  });
  // If the endpoint gets closed on us without a release message, we treat it the same so as not to prevent resource cleanup.
  // At most one of close and error should be handled so as not to falsify the object count.
  const listener = () => {
    finalizeObject(object);
    ep.removeEventListener("close", listener);
    ep.removeEventListener("error", listener);
  };
  ep.addEventListener('close', listener);
  ep.addEventListener('error', listener);
  ep.start?.();
}

function isCloseable(endpoint: object): endpoint is { close(): void } {
  return 'close' in endpoint && typeof endpoint.close === 'function';
}

function closeEndpoint(endpoint: Endpoint) {
  if (isCloseable(endpoint)) endpoint.close();
}

export function wrap<T>(ep: Endpoint, target?: any): Remote<T> {
  return createProxy<T>(ep, [], target) as any;
}

function throwIfProxyReleased(isReleased: boolean) {
  if (isReleased) {
    throw new Error("Proxy has been released and is not useable");
  }
}

async function releaseEndpoint(ep: Endpoint, force = false) {
  if (endpointState.has(ep)) {
    const { resolvers, messageHandler } = endpointState.get(ep)!;
    try {
      const releasedPromise = !force ? requestResponseMessage(ep, {
        type: MessageType.RELEASE,
      }) : null;
      endpointState.delete(ep); // prevent reentry
      await releasedPromise; // now save to await
    } finally {
      // Error all pending promises:
      resolvers.forEach(({ reject }) => reject(new DOMException('Cancelled due to endpoint release', 'AbortError')))
      resolvers.clear();
      ep.removeEventListener("message", messageHandler);
      closeEndpoint(ep);
    }
  }
}

async function finalizeEndpoint(ep: Endpoint) {
  const newCount = (proxyCounter.get(ep) || 0) - 1;
  proxyCounter.set(ep, newCount);
  if (newCount === 0) {
    await releaseEndpoint(ep);
  }
}

const proxyCounter = new WeakMap<Endpoint, number>();
const proxyFinalizers = "FinalizationRegistry" in globalThis
  ? new FinalizationRegistry(finalizeEndpoint)
  : undefined;

function registerProxy(proxy: object, ep: Endpoint) {
  const newCount = (proxyCounter.get(ep) || 0) + 1;
  proxyCounter.set(ep, newCount);
  proxyFinalizers?.register(proxy, ep, proxy);
}

function unregisterProxy(proxy: object) {
  proxyFinalizers?.unregister(proxy);
}

function createProxy<T>(
  ep: Endpoint,
  path: PropertyKey[] = [],
  target: object = function () {}
): Remote<T> {
  let isProxyReleased = false;
  const proxy = new Proxy(target, {
    get(_target, prop) {
      if (prop === Symbol.dispose || prop === releaseProxy) {
        return () => {
          isProxyReleased = true;
          unregisterProxy(proxy);
          releaseEndpoint(ep).catch(() => {}) // Can't await result in sync disposal. Error will be suppressed
        };
      }
      if (prop === Symbol.asyncDispose) {
        return async () => {
          isProxyReleased = true;
          unregisterProxy(proxy);
          await releaseEndpoint(ep);
        };
      }
      throwIfProxyReleased(isProxyReleased);
      if (prop === "then") {
        if (path.length === 0) {
          return { then: () => proxy };
        }
        const r = requestResponseMessage(ep, {
          type: MessageType.GET,
          path: path.map((p) => p.toString()),
        }).then(fromWireValue.bind(ep));
        return r.then.bind(r);
      }
      return createProxy(ep, [...path, prop]);
    },
    set(_target, prop, rawValue) {
      throwIfProxyReleased(isProxyReleased);
      // FIXME: ES6 Proxy Handler `set` methods are supposed to return a
      // boolean. To show good will, we return true asynchronously ¯\_(ツ)_/¯
      const [value, transfer] = toWireValue.call(ep, rawValue);
      return requestResponseMessage(
        ep,
        {
          type: MessageType.SET,
          path: [...path, prop].map((p) => p.toString()),
          value,
        },
        transfer
      ).then(fromWireValue.bind(ep)) as any;
    },
    apply(_target, _thisArg, rawArgumentList) {
      throwIfProxyReleased(isProxyReleased);
      const last = path[path.length - 1];
      if (last === createEndpoint) {
        const { port1, port2 } = new (ep[messageChannel] ?? MessageChannel)();
        requestResponseMessage(ep, {
          type: MessageType.ENDPOINT,
          value: port2,
        }, [port2]).catch(() => {
          // XXX: Should these events be dispatched? Should they dispatch on the parent endpoint or the new port?
          // port1.dispatchEvent(new MessageEvent('messageerror', { data: err }));
          // ep.dispatchEvent(new ErrorEvent('error', { error: Error('Failed to create endpoint') }));
          port1.close();
        });
        return port1;
      }
      // We just pretend that `bind()` didn’t happen.
      if (last === "bind") {
        return createProxy(ep, path.slice(0, -1));
      }
      // Pretending that `call()` and `apply()` didn’t happen either
      if (last === "call") {
        path = path.slice(0, -1);
        rawArgumentList = rawArgumentList.slice(1);
      }
      if (last === "apply") {
        path = path.slice(0, -1);
        rawArgumentList = rawArgumentList[1];
      }
      const [argumentList, transfer] = processTuple(rawArgumentList, ep);
      return requestResponseMessage(
        ep,
        {
          type: MessageType.APPLY,
          path: path.map((p) => p.toString()),
          argumentList,
        },
        transfer
      ).then(fromWireValue.bind(ep));
    },
    construct(_target, rawArgumentList) {
      throwIfProxyReleased(isProxyReleased);
      const [argumentList, transfer] = processTuple(rawArgumentList, ep);
      return requestResponseMessage(
        ep,
        {
          type: MessageType.CONSTRUCT,
          path: path.map((p) => p.toString()),
          argumentList,
        },
        transfer
      ).then(fromWireValue.bind(ep));
    },
    has(_target, prop) {
      throwIfProxyReleased(isProxyReleased);
      // Can only check for known local properties, the rest can only be determined asynchronously, so we can only return `false` in that case.
      return (
        prop === Symbol.dispose || 
        prop === releaseProxy ||
        prop === Symbol.asyncDispose ||
        prop === createEndpoint ||
        prop === "then"
      );
    }
  });

  // If the endpoint gets closed on us, we should mark the proxy as released and reject all pending promises.
  // This shouldn't really happen since the proxy must be closed from this side, either through manual dispose or finalization registry.
  // Also note that support for the `close` event is unclear (MDN doesn't document it, spec says it should be there...), so this is a last resort.
  ep.addEventListener("close", async () => {
    isProxyReleased = true;
    unregisterProxy(proxy);
    // Passing the force flag to skip sending a release message, since the endpoint is already closed.
    await releaseEndpoint(ep, true);
  });

  // Similarly, if the endpoint errors for any reason, we should mark the proxy as released and reject all pending promises.
  ep.addEventListener("error", async () => {
    isProxyReleased = true;
    unregisterProxy(proxy);
    await releaseEndpoint(ep, true);
  });

  registerProxy(proxy, ep);
  return proxy as any;
}

const flatten: <T>(arr: (T | T[])[]) => T[] = 'flat' in Array.prototype
  ? arr => arr.flat()
  : arr => Array.prototype.concat.apply([], arr);

function processTuple(argumentList: any[], ep: Endpoint): TransferableTuple<WireValue[]> {
  const processed = argumentList.map(toWireValue, ep);
  return [processed.map((v) => v[0]), flatten(processed.map((v) => v[1]))];
}

const transferCache = new WeakMap<any, Transferable[]>();
export function transfer<T>(obj: T, transfers: Transferable[]): T {
  transferCache.set(obj, transfers);
  return obj;
}

export function proxy<T extends {}>(obj: T): T & ProxyMarked {
  const n = obj as T & ProxyMarked;
  n[proxyMarker] = true;
  return n;
}

export function windowEndpoint(
  w: PostMessageWithOrigin,
  context: MessageEventTarget = globalThis,
  targetOrigin = "*"
): Endpoint {
  return {
    postMessage: (msg: any, transfer: Transferable[]) => w.postMessage(msg, targetOrigin, transfer),
    addEventListener: context.addEventListener.bind(context),
    removeEventListener: context.removeEventListener.bind(context),
  };
}

function toWireValue(this: Endpoint, value: unknown): TransferableTuple<WireValue> {
  if (isReceiver(value)) {
    for (const [name, handler] of transferHandlers) {
      if (handler.canHandle(value, this)) {
        const [serializedValue, transfer] = handler.serialize(value, this);
        return [
          {
            type: WireValueType.HANDLER,
            name,
            value: serializedValue,
          },
          transfer,
        ];
      }
    }
  }
  return [
    {
      type: WireValueType.RAW,
      value,
    },
    transferCache.get(value) || [],
  ];
}

function fromWireValue(this: Endpoint, value: WireValue): any {
  switch (value.type) {
    case WireValueType.HANDLER:
      return transferHandlers.get(value.name)!.deserialize(value.value, this);
    case WireValueType.RAW:
      return value.value;
  }
}

const makeMessageHandler = (resolverMap: ResolversMap<MessageId, WireValue>) => (ev: MessageEvent<WireValue|null>) => {
  const { data } = ev;
  if (!data?.id) {
    return;
  }
  const resolvers = resolverMap.get(data.id);
  if (!resolvers) {
    return;
  }
  resolverMap.delete(data.id);
  resolvers.resolve(data);
}

function requestResponseMessage(
  ep: Endpoint,
  msg: Message,
  transfer?: Transferable[]
): Promise<WireValue> {
  return new Promise((resolve, reject) => {
    let resolvers = endpointState.get(ep)?.resolvers;
    if (!resolvers) {
      resolvers = new Map();
      const messageHandler = makeMessageHandler(resolvers);
      endpointState.set(ep, { resolvers, messageHandler });
      ep.addEventListener("message", messageHandler);
      ep.start?.();
    }
    const id = generateId();
    msg.id = id;
    resolvers.set(id, { resolve, reject });
    ep.postMessage(msg, transfer);
  });
}

function generateId(): MessageId {
  return Math.random() * 2**32 >>> 0;
}
