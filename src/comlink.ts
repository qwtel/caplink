/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Endpoint,
  ReceiverEndpoint,
  Message,
  MessageType,
  PostMessageWithOrigin,
  WireValue,
  WireValueType,
  IterMessage,
  IterType,
  MessageId,
} from "./protocol";
export type { Endpoint };

export const proxyMarker = Symbol("Comlink.proxy");
export const tupleMarker = Symbol("Comlink.tuple")
export const recordMarker = Symbol("Comlink.record")
export const createEndpoint = Symbol("Comlink.endpoint");
/** @deprecated Use `Symbol.asyncDispose` instead */
export const releaseProxy = Symbol("Comlink.releaseProxy");
/** @deprecated Use `Symbol.dispose` or `Symbol.asyncDispose` instead */
export const finalizer = Symbol("Comlink.finalizer");

const throwMarker = Symbol("Comlink.thrown");

/**
 * Interface of values that were marked to be proxied with `comlink.proxy()`.
 * Can also be implemented by classes.
 */
export interface ProxyMarked {
  [proxyMarker]: true;
}

export interface TupleMarked {
  [tupleMarker]: true;
}

export interface RecordMarked {
  [recordMarker]: true;
}

type TupleRecordMarker = typeof tupleMarker|typeof recordMarker;

/**
 * Takes a type and wraps it in a Promise, if it not already is one.
 * This is to avoid `Promise<Promise<T>>`.
 *
 * This is the inverse of `Unpromisify<T>`.
 */
type Promisify<T> = T extends PromiseLike<unknown> ? T : Promise<T>;

type Unmark<T> = T extends TupleMarked|RecordMarked
  ? { [P in keyof T as Exclude<P, TupleRecordMarker>]: T[P] }
  : T

type AsyncIterify<T> = T extends MaybeAsyncGenerator<infer A, infer B, infer C>
  ? AsyncGenerator<Unmark<ProxyOrClone<A>>, Unmark<ProxyOrClone<B>>, UnproxyOrClone<C>>
  : T;

type Asyncify<T> = T extends TupleMarked|RecordMarked
  ? Promise<{ [P in keyof T as Exclude<P, TupleRecordMarker>]: AsyncIterify<T[P]> }>
  : T extends MaybeAsyncGenerator<infer A, infer B, infer C>
    ? AsyncGenerator<Unmark<ProxyOrClone<A>>, Unmark<ProxyOrClone<B>>, UnproxyOrClone<C>>
    : Promisify<T>;

/**
 * Takes the raw type of a remote property and returns the type that is visible to the local thread on the proxy.
 *
 * Note: This needs to be its own type alias, otherwise it will not distribute over unions.
 * See https://www.typescriptlang.org/docs/handbook/advanced-types.html#distributive-conditional-types
 */
type RemoteProperty<T> =
  // If the value is a method, comlink will proxy it automatically.
  // Objects are only proxied if they are marked to be proxied.
  // Otherwise, the property is converted to a Promise that resolves the cloned value.
  T extends Function | ProxyMarked ? Remote<T> : Asyncify<T>;

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
export type ProxyOrClone<T> = T extends TupleMarked|RecordMarked 
  ? { [P in keyof T]: ProxyOrClone<T[P]> }
  : T extends ProxyMarked 
    ? Remote<T> 
    : T;
/**
 * Inverse of `ProxyOrClone<T>`.
 */
export type UnproxyOrClone<T> = T extends RemoteObject<TupleMarked|RecordMarked>
  ? { [P in keyof T ]: UnproxyOrClone<T[P]> }
  : T extends RemoteObject<ProxyMarked>
    ? Local<T>
    : T;

/**
 * Takes the raw type of a remote object in the other thread and returns the type as it is visible to the local thread
 * when proxied with `Comlink.proxy()`.
 *
 * This does not handle call signatures, which is handled by the more general `Remote<T>` type.
 *
 * @template T The raw type of a remote object as seen in the other thread.
 */
export type RemoteObject<T> = { [P in keyof T]: RemoteProperty<T[P]> };
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
 * Additional special comlink methods available on each proxy returned by `Comlink.wrap()`.
 */
export interface ProxyMethods {
  [createEndpoint]: () => Promise<MessagePort>;
  [Symbol.asyncDispose]: () => Promise<void>;
  /** @deprecated Use `Symbol.asyncDispose` instead */
  [releaseProxy]: () => Promise<void>;
}

/**
 * Takes the raw type of a remote object, function or class in the other thread and returns the type as it is visible to
 * the local thread from the proxy return value of `Comlink.wrap()` or `Comlink.proxy()`.
 */
export type Remote<T> =
  // Handle properties
  RemoteObject<T> &
    // Handle call signature (if present)
    (T extends (...args: infer TArguments) => infer TReturn
      ? (
          ...args: { [I in keyof TArguments]: UnproxyOrClone<TArguments[I]> }
        ) => Asyncify<ProxyOrClone<Awaited<TReturn>>>
      : unknown) &
    // Handle construct signature (if present)
    // The return of construct signatures is always proxied (whether marked or not)
    (T extends { new (...args: infer TArguments): infer TInstance }
      ? {
          new (
            ...args: {
              [I in keyof TArguments]: UnproxyOrClone<TArguments[I]>;
            }
          ): Asyncify<Remote<TInstance>>;
        }
      : unknown) &
    // Include additional special comlink methods available on the proxy.
    ProxyMethods;

/**
 * Expresses that a type can be either a sync or async.
 */
type MaybePromise<T> = PromiseLike<T> | T;
type MaybeAsyncGenerator<T, TReturn, TNext> = Generator<T, TReturn, TNext>|AsyncGenerator<T, TReturn, TNext>;


/**
 * Takes the raw type of a remote object, function or class as a remote thread would see it through a proxy (e.g. when
 * passed in as a function argument) and returns the type the local thread has to supply.
 *
 * This is the inverse of `Remote<T>`. It takes a `Remote<T>` and returns its original input `T`.
 */
export type Local<T> =
  // Omit the special proxy methods (they don't need to be supplied, comlink adds them)
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

const isObject = (val: unknown): val is object =>
  (typeof val === "object" && val !== null) || typeof val === "function";

type TransferableTuple<T> = [value: T, transferables: Transferable[]];

type Rec<T> = Record<PropertyKey, T>

/**
 * Customizes the serialization of certain values as determined by `canHandle()`.
 *
 * @template T The input type being handled by this transfer handler.
 * @template S The serialized type sent over the wire.
 */
export interface TransferHandler<T, S> {
  /**
   * Gets called for every value to determine whether this transfer handler
   * should serialize the value, which includes checking that it is of the right
   * type (but can perform checks beyond that as well).
   */
  canHandle(value: unknown): value is T;

  /**
   * Gets called with the value if `canHandle()` returned `true` to produce a
   * value that can be sent in a message, consisting of structured-cloneable
   * values and/or transferrable objects.
   */
  serialize(value: T): TransferableTuple<S>;

  /**
   * Gets called to deserialize an incoming value that was serialized in the
   * other thread with this transfer handler (known through the name it was
   * registered under).
   */
  deserialize(value: S): T;
}

/**
 * Internal transfer handle to handle objects marked to proxy.
 */
const proxyTransferHandler = {
  canHandle: (val): val is ProxyMarked => isObject(val) && (val as ProxyMarked)[proxyMarker],
  serialize(obj) {
    const { port1, port2 } = new MessageChannel();
    expose(obj, port1);
    return [port2, [port2]];
  },
  deserialize(port) {
    port.start();
    return wrap(port);
  },
} satisfies TransferHandler<object, MessagePort>;

const tupleTransferHandler = {
  canHandle: (val): val is any[] => Array.isArray(val) && (val as any[] & TupleMarked)[tupleMarker],
  serialize: (val) => processTuple(val),
  deserialize: (val) => val.map(fromWireValue)
} satisfies TransferHandler<any[], WireValue[]>;

const recordTransferHandler = {
  canHandle: (val): val is Rec<any> => isObject(val) && (val as RecordMarked)[recordMarker],
  serialize: (val) => processRecord(val),
  deserialize: (val) => { const ret = {} as any; for (const k in val) ret[k] = fromWireValue(val[k]); return ret }
} satisfies TransferHandler<Rec<any>, Rec<WireValue>>;

const promiseTransferHandler = {
  canHandle: (val): val is PromiseLike<any> => isObject(val) && 'then' in val,
  serialize: (val) => {
    const { port1, port2 } = new MessageChannel();
    val.then(
      value => port1.postMessage(...toWireValue(value)),
      value => port1.postMessage(...toWireValue({ value, [throwMarker]: 0 })),
    );
    nullFinalizers?.register(val, port1);
    port1.start()
    return [port2, [port2]]
  },

  deserialize: (port) => {
    const promise = new Promise((resolve, reject) => {
      port.addEventListener("message", (ev: MessageEvent<WireValue|null>) => {
        if (ev.data != null) {
          try {
            resolve(fromWireValue(ev.data))
          } catch (err) {
            reject(err)
          }
        }
        port.close();
      }, { once: true });
    });
    port.start();
    return promise;
  }
} satisfies TransferHandler<PromiseLike<any>, MessagePort>;

async function postIterMessage(port: MessagePort, getReturnValue: () => MaybePromise<IteratorResult<any>>, id?: MessageId) {
  let returnValue;
  try {
    returnValue = record(await getReturnValue())
  } catch (value) {
    returnValue = { value, [throwMarker]: 0 };
  }
  try {
      const [wireValue, transferables] = toWireValue(returnValue);
      wireValue.id = id;
      port.postMessage(wireValue, transferables);
  } catch {
    // Send Serialization Error To Caller
    const [wireValue, transferables] = toWireValue({
      value: new TypeError("Unserializable return value"),
      [throwMarker]: 0,
    });
    wireValue.id = id;
    port.postMessage(wireValue, transferables);
  };
}

const generatorTransferHandler = {
  canHandle: (val): val is Generator|AsyncGenerator => 
    isObject(val) && 
    'next' in val && 
    'return' in val && 
    'throw' in val && 
    (Symbol.asyncIterator in val || Symbol.iterator in val),

  serialize: (gen) => {
    const { port1, port2 } = new MessageChannel();

    port1.addEventListener("message", async function callback(ev: MessageEvent<IterMessage|null>) {
      if (ev.data != null) {
        const { type, id, value } = ev.data;
        switch (type) {
          case IterType.NEXT: 
            postIterMessage(port1, () => gen.next(fromWireValue(value)), id);
            break;
          case IterType.RETURN:
            postIterMessage(port1, () => gen.return(fromWireValue(value)), id);
            port1.removeEventListener("message", callback);
            port1.close();
            break;
          case IterType.THROW:
            try {
              fromWireValue(value);
            } catch (err) {
              postIterMessage(port1, () => gen.throw(err), id);
              port1.removeEventListener("message", callback);
              port1.close();
            }
        }
      } else {
        port1.removeEventListener("message", callback);
        port1.close();
      }
    });

    port1.start()
    return [port2, [port2]]
  },

  deserialize: (port) => {
    const generator: AsyncGenerator = {
      async next(x) {
        const [wireValue, transfer] = toWireValue(x);
        const y = await requestResponseMessage(port, { type: IterType.NEXT, value: wireValue }, transfer);
        return fromWireValue(y);
      },
      async return(x) {
        const [wireValue, transfer] = toWireValue(x);
        const y = await requestResponseMessage(port, { type: IterType.RETURN, value: wireValue }, transfer);
        return fromWireValue(y);
      },
      async throw(e) {
        const [wireValue, transfer] = toWireValue({ value: e, [throwMarker]: 0 });
        const y = await requestResponseMessage(port, { type: IterType.THROW, value: wireValue }, transfer);
        return fromWireValue(y);
      },
      [Symbol.asyncIterator]() { return this },
    };

    nullFinalizers?.register(generator, port);

    return generator;
  }
} satisfies TransferHandler<Generator|AsyncGenerator, MessagePort>;

interface ThrownValue {
  [throwMarker]: unknown; // just needs to be present
  value: unknown;
}
type SerializedThrownValue =
  | { isError: true; value: Error }
  | { isError: false; value: unknown };

type PendingListenersMap = Map<MessageId, (value: MaybePromise<WireValue>) => void>;
type MessageHandler = (ev: MessageEvent<WireValue|null>) => void
type EndpointMeta = { 
  pendingListeners: PendingListenersMap, 
  messageHandler: MessageHandler;
};

const endpointMeta = new WeakMap<Endpoint, EndpointMeta>;

/**
 * Internal transfer handler to handle thrown exceptions.
 */
const throwTransferHandler: TransferHandler<
  ThrownValue,
  SerializedThrownValue
> = {
  canHandle: (value): value is ThrownValue => isObject(value) && throwMarker in value,
  serialize({ value }) {
    let serialized: SerializedThrownValue;
    if (value instanceof Error) {
      serialized = {
        isError: true,
        value: {
          message: value.message,
          name: value.name,
          stack: value.stack,
        },
      };
    } else {
      serialized = { isError: false, value };
    }
    return [serialized, []];
  },
  deserialize(serialized) {
    if (serialized.isError) {
      throw Object.assign(
        new Error(serialized.value.message),
        serialized.value
      );
    }
    throw serialized.value;
  },
};

/**
 * Allows customizing the serialization of certain values.
 */
export const transferHandlers = new Map<
  string,
  TransferHandler<unknown, unknown>
>([
  ["proxy", proxyTransferHandler],
  ["throw", throwTransferHandler],
  ["tuple", tupleTransferHandler],
  ["record", recordTransferHandler],
  ["promise", promiseTransferHandler],
  ["generator", generatorTransferHandler],
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

export function expose(
  obj: any,
  ep: Endpoint = globalThis as any,
  allowedOrigins: (string | RegExp)[] = ["*"]
) {
  ep.addEventListener("message", async function callback(ev) {
    if (!ev || !ev.data) {
      return;
    }
    if (!isAllowedOrigin(allowedOrigins, ev.origin)) {
      console.warn(`Invalid origin '${ev.origin}' for comlink proxy`);
      return;
    }
    ev.data.path ||= [];
    const { id, type, path } = ev.data as Message & { path: string[] }
    const argumentList = (ev.data.argumentList as any[] || []).map(fromWireValue);
    let returnValue;
    try {
      const parent = path.slice(0, -1).reduce((obj, prop) => obj[prop], obj);
      const rawValue = path.reduce((obj, prop) => obj[prop], obj);
      switch (type) {
        case MessageType.GET:
          {
            returnValue = rawValue;
          }
          break;
        case MessageType.SET:
          {
            parent[path.slice(-1)[0]] = fromWireValue(ev.data.value);
            returnValue = true;
          }
          break;
        case MessageType.APPLY:
          {
            returnValue = rawValue.apply(parent, argumentList);
          }
          break;
        case MessageType.CONSTRUCT:
          {
            const value = new rawValue(...argumentList);
            returnValue = proxy(value);
          }
          break;
        case MessageType.ENDPOINT:
          {
            const { port1, port2 } = new MessageChannel();
            expose(obj, port2);
            returnValue = transfer(port1, [port1]);
          }
          break;
        case MessageType.RELEASE:
          {
            returnValue = undefined;
          }
          break;
        default:
          return;
      }
    } catch (value) {
      returnValue = { value, [throwMarker]: 0 };
    }
    let safeReturnValue;
    try {
      safeReturnValue = await returnValue;
    } catch (value) {
      safeReturnValue = { value, [throwMarker]: 0 };
    }
    try {
      const [wireValue, transferables] = toWireValue(safeReturnValue);
      wireValue.id = id;
      ep.postMessage(wireValue, transferables);
      if (type === MessageType.RELEASE) {
        // detach and deactivate after sending release response above.
        ep.removeEventListener("message", callback);
        closeEndpoint(ep);
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
    catch {
      // Send Serialization Error To Caller
      const [wireValue, transferables] = toWireValue({
        value: new TypeError("Unserializable return value"),
        [throwMarker]: 0,
      });
      wireValue.id = id;
      ep.postMessage(wireValue, transferables);
    }
  });
  ep.start?.();
}

function isMessagePort(endpoint: Endpoint): endpoint is MessagePort {
  return endpoint instanceof MessagePort || endpoint.constructor.name === "MessagePort";
}

function closeEndpoint(endpoint: Endpoint) {
  if (isMessagePort(endpoint)) endpoint.close();
}

const makeMessageHandler = (pendingListeners: PendingListenersMap) => (ev: MessageEvent<WireValue|null>) => {
  const { data } = ev;
  if (!data?.id) {
    return;
  }
  const resolve = pendingListeners.get(data.id);
  if (!resolve) {
    return;
  }
  pendingListeners.delete(data.id);
  resolve(data);
}

export function wrap<T>(ep: Endpoint, target?: any): Remote<T> {
  return createProxy<T>(ep, [], target) as any;
}

function throwIfProxyReleased(isReleased: boolean) {
  if (isReleased) {
    throw new Error("Proxy has been released and is not useable");
  }
}

async function releaseEndpoint(ep: Endpoint) {
  await requestResponseMessage(ep, {
    type: MessageType.RELEASE,
  });
  if (endpointMeta.has(ep)) {
    const { pendingListeners, messageHandler } = endpointMeta.get(ep)!;
    endpointMeta.delete(ep);
    pendingListeners.clear();
    ep.removeEventListener("message", messageHandler);
  }
  closeEndpoint(ep);
}

async function finalizeEndpoint(ep: Endpoint) {
  const newCount = (proxyCounter.get(ep) || 0) - 1;
  proxyCounter.set(ep, newCount);
  if (newCount === 0) {
    await releaseEndpoint(ep);
  }
}

const proxyCounter = new WeakMap<Endpoint, number>();
const proxyFinalizers = "FinalizationRegistry" in globalThis ? new FinalizationRegistry(finalizeEndpoint) : undefined;

function registerProxy(proxy: object, ep: Endpoint) {
  const newCount = (proxyCounter.get(ep) || 0) + 1;
  proxyCounter.set(ep, newCount);
  proxyFinalizers?.register(proxy, ep, proxy);
}

function unregisterProxy(proxy: object) {
  proxyFinalizers?.unregister(proxy);
}

/** @deprecated Should this use Comlink's proxy release functionality instead? */
function finalizeViaNullMessage(port: MessagePort) {
  port.postMessage(null)
  port.close();
}
/** @deprecated Should this use Comlink's proxy release functionality instead? */
const nullFinalizers = "FinalizationRegistry" in globalThis ? new FinalizationRegistry(finalizeViaNullMessage) : undefined;

const forwardAsyncIter = (gen: Promise<AsyncGenerator>) => 
  Object.defineProperty(gen, Symbol.asyncIterator, {
    writable: true,
    enumerable: false,
    configurable: true,
    value: () => ({
      async next(x: any) { return (await gen).next(x) },
      async return(x: any) { return (await gen).return(x) },
      async throw(e: any) { return (await gen).throw(e) },
      [Symbol.asyncIterator]() { return this },
    }),
  })

function createProxy<T>(
  ep: Endpoint,
  path: PropertyKey[] = [],
  target: object = function () {}
): Remote<T> {
  let isProxyReleased = false;
  const proxy = new Proxy(target, {
    get(_target, prop) {
      throwIfProxyReleased(isProxyReleased);
      if (prop === releaseProxy || ('asyncDispose' in Symbol && prop === Symbol.asyncDispose)) {
        return async () => {
          unregisterProxy(proxy);
          await releaseEndpoint(ep);
          isProxyReleased = true;
        };
      }
      if (prop === "then") {
        if (path.length === 0) {
          return { then: () => proxy };
        }
        const r = requestResponseMessage(ep, {
          type: MessageType.GET,
          path: path.map((p) => p.toString()),
        }).then(fromWireValue);
        return r.then.bind(r);
      }
      return createProxy(ep, [...path, prop]);
    },
    set(_target, prop, rawValue) {
      throwIfProxyReleased(isProxyReleased);
      // FIXME: ES6 Proxy Handler `set` methods are supposed to return a
      // boolean. To show good will, we return true asynchronously ¯\_(ツ)_/¯
      const [value, transferables] = toWireValue(rawValue);
      return requestResponseMessage(
        ep,
        {
          type: MessageType.SET,
          path: [...path, prop].map((p) => p.toString()),
          value,
        },
        transferables
      ).then(fromWireValue) as any;
    },
    apply(_target, _thisArg, rawArgumentList) {
      throwIfProxyReleased(isProxyReleased);
      const last = path[path.length - 1];
      if ((last as any) === createEndpoint) {
        return requestResponseMessage(ep, {
          type: MessageType.ENDPOINT,
        }).then(fromWireValue);
      }
      // We just pretend that `bind()` didn’t happen.
      if (last === "bind") {
        return createProxy(ep, path.slice(0, -1));
      }
      const [argumentList, transferables] = processTuple(rawArgumentList);
      const ret = requestResponseMessage(
        ep,
        {
          type: MessageType.APPLY,
          path: path.map((p) => p.toString()),
          argumentList,
        },
        transferables
      ).then(fromWireValue);
      // If user expects async iter, forward calls to return value once it has resolved
      forwardAsyncIter(ret);
      return ret;
    },
    construct(_target, rawArgumentList) {
      throwIfProxyReleased(isProxyReleased);
      const [argumentList, transferables] = processTuple(rawArgumentList);
      const ret = requestResponseMessage(
        ep,
        {
          type: MessageType.CONSTRUCT,
          path: path.map((p) => p.toString()),
          argumentList,
        },
        transferables
      ).then(fromWireValue);
      forwardAsyncIter(ret);
      return ret;
    },
  });
  registerProxy(proxy, ep);
  return proxy as any;
}

function processTuple(argumentList: any[]): TransferableTuple<WireValue[]> {
  const length = argumentList.length;
  const values = new Array<WireValue>(length);
  const transferables = new Array<Transferable>();
  for (let i = 0; i < length; i++) {
    const [v, ts] = toWireValue(argumentList[i]);
    values[i] = v;
    if (ts) transferables.push(...ts);
  }
  return [values, transferables];
}

function processRecord(argumentRec: Rec<any>): TransferableTuple<Rec<WireValue>> {
  const transferables = new Array<Transferable>();
  const obj = {} as Rec<WireValue>;
  for (const key in argumentRec) {
    const [v, ts] = toWireValue(argumentRec[key]);
    obj[key] = v;
    if (ts) transferables.push(...ts);
  }
  return [obj, transferables];
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

export function tuple<T extends {}>(obj: T): T & TupleMarked {
  const n = obj as T & TupleMarked;
  n[tupleMarker] = true;
  return n;
}

export function record<T extends {}>(obj: T): T & RecordMarked {
  const n = obj as T & RecordMarked;
  n[recordMarker] = true;
  return n;
}

export function windowEndpoint(
  w: PostMessageWithOrigin,
  context: ReceiverEndpoint = globalThis,
  targetOrigin = "*"
): Endpoint {
  return {
    postMessage: (msg: any, transferables: Transferable[]) => w.postMessage(msg, targetOrigin, transferables),
    addEventListener: context.addEventListener.bind(context),
    removeEventListener: context.removeEventListener.bind(context),
  };
}

function toWireValue(value: any): TransferableTuple<WireValue> {
  for (const [name, handler] of transferHandlers) {
    if (handler.canHandle(value)) {
      const [serializedValue, transferables] = handler.serialize(value);
      return [
        {
          type: WireValueType.HANDLER,
          name,
          value: serializedValue,
        },
        transferables,
      ];
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

function fromWireValue(value: WireValue): any {
  switch (value.type) {
    case WireValueType.HANDLER:
      return transferHandlers.get(value.name)!.deserialize(value.value);
    case WireValueType.RAW:
      return value.value;
  }
}

function requestResponseMessage(
  ep: Endpoint,
  msg: Message,
  transfers?: Transferable[]
): Promise<WireValue> {
  return new Promise((resolve) => {
    let pendingListeners = endpointMeta.get(ep)?.pendingListeners;
    if (!pendingListeners) {
      pendingListeners = new Map();
      const messageHandler = makeMessageHandler(pendingListeners);
      endpointMeta.set(ep, { pendingListeners, messageHandler });
      ep.addEventListener("message", messageHandler);
    }
    const id = generateId();
    msg.id = id;
    pendingListeners.set(id, resolve);
    ep.start?.();
    ep.postMessage(msg, transfers);
  });
}

function generateId(): MessageId {
  return Math.random() * 2**32 >>> 0;
}
