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
  HandlerWireValue,
  WireValue,
  WireValueType,
  messageChannel,
  toNative,
  adoptNative,
} from "./protocol.ts";

export type { Endpoint, MessageEventTarget, PostMessageWithOrigin };

export type PromiseWithResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
};

export const proxyMarker = Symbol("Caplink.proxy");
export const tupleMarker = Symbol("Caplink.tuple");
export const recordMarker = Symbol("Caplink.record");
declare const tupleValue: unique symbol;
declare const recordValue: unique symbol;
export const createEndpoint = Symbol("Caplink.endpoint");
/** @deprecated Use `Symbol.dispose` or `Symbol.asyncDispose` instead */
export const releaseProxy = Symbol("Caplink.releaseProxy");
/** @deprecated Use `Symbol.dispose` or `Symbol.asyncDispose` instead */
export const finalizer = Symbol("Caplink.finalizer");
export { messageChannel, toNative, adoptNative };

export const releaseConfig = { timeout: 30_000 };

const throwMarker = Symbol("Caplink.thrown");

/**
 * Interface of values that were marked to be proxied with `caplink.proxy()`.
 * Can also be implemented by classes.
 */
export interface ProxyMarked {
  [proxyMarker]: true;
}

export interface TupleMarked<Value extends readonly unknown[] = readonly unknown[]> {
  readonly [tupleMarker]: true;
  readonly [tupleValue]?: Value;
}

export interface RecordMarked<Value extends object = object> {
  readonly [recordMarker]: true;
  readonly [recordValue]?: Value;
}

type TupleOrRecordMarked = TupleMarked | RecordMarked;

type ProxyTuple<T extends readonly unknown[]> = T extends unknown[]
  ? { [Index in keyof T]: ProxyOrClone<T[Index]> }
  : Readonly<{ [Index in keyof T]: ProxyOrClone<T[Index]> }>;

type UnproxyTuple<T extends readonly unknown[]> = T extends unknown[]
  ? { [Index in keyof T]: UnproxyOrClone<T[Index]> }
  : Readonly<{ [Index in keyof T]: UnproxyOrClone<T[Index]> }>;

/**
 * Interface for our own proxy objects. The defining characteristic is the ability to get the underlying message port.
 */
interface Proxy {
  [createEndpoint](): MessagePort
}

type ProxyValue = Proxy | ProxyMarked | Function;
type CapabilityId = string;
type RequestId = number;

interface ProxyWireValue {
  /** Opaque identity assigned by the realm that owns the capability. */
  capability?: CapabilityId;
  port: MessagePort;
}

interface ExportEntry {
  readonly capability: CapabilityId;
  readonly value: object;
  exposures: number;
}

// Capability IDs are realm-wide. A capability may arrive through the main
// endpoint, a callback endpoint, or another capability endpoint and must keep
// the same JavaScript identity across all of them.
class CapabilityRegistry {
  private static readonly localCapEntries = new WeakMap<object, ExportEntry>();
  private static readonly localCaps = new Map<CapabilityId, ExportEntry>();
  private static readonly exposures = new WeakMap<Endpoint, ExportEntry>();
  private static readonly remoteCapIds = new WeakMap<object, CapabilityId>();
  private static readonly remoteCaps = new Map<CapabilityId, WeakRef<Proxy>>();
  private static readonly remoteCapFinalizers = 'FinalizationRegistry' in globalThis
    ? new FinalizationRegistry<readonly [CapabilityId, WeakRef<Proxy>]>(([capability, reference]) => {
        this.#deleteRemote(capability, reference);
      })
    : undefined;

  private constructor() {}

  static #deleteRemote(capability: CapabilityId, reference?: WeakRef<Proxy>) {
    if (!reference || this.remoteCaps.get(capability) === reference) {
      this.remoteCaps.delete(capability);
    }
  }

  static #getLocalEntry(value: object) {
    let entry = this.localCapEntries.get(value);
    if (!entry) {
      entry = { capability: crypto.randomUUID(), value, exposures: 0 };
      this.localCapEntries.set(value, entry);
    }
    this.localCaps.set(entry.capability, entry);
    return entry;
  }

  static getId(value: object) {
    return this.#getLocalEntry(value).capability;
  }

  static expose(value: object, endpoint: Endpoint) {
    if (this.exposures.has(endpoint)) {
      throw Error('Endpoint is already exposing another object and cannot be reused.');
    }
    const entry = this.#getLocalEntry(value);
    entry.exposures += 1;
    this.exposures.set(endpoint, entry);
  }

  static async release(endpoint: Endpoint) {
    const entry = this.exposures.get(endpoint);
    if (!entry) return;
    this.exposures.delete(endpoint);
    if (--entry.exposures === 0) {
      if (this.localCaps.get(entry.capability) === entry) {
        this.localCaps.delete(entry.capability);
      }
      await runDisposers(entry.value);
    }
  }

  static getLocal(capability: CapabilityId) {
    return this.localCaps.get(capability)?.value;
  }

  static getRemoteId(proxy: object) {
    return this.remoteCapIds.get(proxy);
  }

  static getRemote(capability: CapabilityId) {
    const reference = this.remoteCaps.get(capability);
    const proxy = reference?.deref();
    if (reference && !proxy) this.#deleteRemote(capability, reference);
    return proxy;
  }

  static addRemote(capability: CapabilityId, proxy: Proxy, endpoint: Endpoint) {
    const reference = new WeakRef(proxy);
    this.remoteCapIds.set(proxy, capability);
    this.remoteCaps.set(capability, reference);
    endpointState.get(endpoint)!.capability = capability;
    this.remoteCapFinalizers?.register(proxy, [capability, reference], proxy);
  }

  static forget(proxy: object) {
    const capability = this.remoteCapIds.get(proxy);
    if (capability && this.remoteCaps.get(capability)?.deref() === proxy) {
      this.#deleteRemote(capability);
    }
    this.remoteCapIds.delete(proxy);
    this.remoteCapFinalizers?.unregister(proxy);
  }

  static forgetEndpoint(endpoint: Endpoint) {
    const state = endpointState.get(endpoint);
    if (state?.capability) {
      this.#deleteRemote(state.capability);
      delete state.capability;
    }
  }
}

const forbiddenPathMembers = new Set<PropertyKey>([
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  '__proto__', 'arguments', 'caller', 'constructor', 'prototype',
]);

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
  T extends Function | ProxyMarked ? Remote<T>
  : T extends TupleOrRecordMarked ? Promisify<ProxyOrClone<T>>
  : Promisify<T>;

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
 * Proxies functions and explicitly marked objects, and clones other values.
 */
export type ProxyOrClone<T> = T extends TupleMarked<infer Value>
  ? ProxyTuple<Value>
  : T extends RecordMarked<infer Value>
  ? { [P in keyof Value]: ProxyOrClone<Value[P]> }
  : T extends Function | ProxyMarked ? Remote<T>
  : T;
/**
 * Inverse of `ProxyOrClone<T>`.
 */
export type UnproxyOrClone<T> = T extends TupleMarked<infer Value>
  ? UnproxyTuple<Value>
  : T extends RecordMarked<infer Value>
  ? { [P in keyof Value]: UnproxyOrClone<Value[P]> }
  : T extends ProxyMarked
  ? T | Remote<T>
  : T extends Remote<infer U>
  ? U & ProxyMarked | Remote<U>
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
  [createEndpoint](): MessagePort;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
  /** @deprecated Use `Symbol.dispose` or `Symbol.asyncDispose` instead */
  [releaseProxy](): Promise<void>;
}

/**
 * Takes the raw type of a remote object, function or class in the other thread and returns the type as it is visible to
 * the local thread from the proxy return value of `Caplink.wrap()` or `Caplink.proxy()`.
 */
export type Remote<T> =
  // Handle properties
  (T extends object ? RemoteObject<T> : T) &
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
  (T extends object ? Omit<LocalObject<T>, keyof ProxyMethods> : T) &
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

const isNativeMessagePort = (x: unknown): x is MessagePort => {
  return ('MessagePort' in globalThis && x instanceof globalThis.MessagePort);
}
const isNativeConvertible = (x: unknown): x is { [toNative](): MessagePort } => {
  return isReceiver(x) && toNative in x;
}

/**
 * Internal transfer handle to handle objects marked to proxy.
 */
const proxyTransferHandler = {
  canHandle: (val): val is ProxyValue => (
    typeof val === 'function' || proxyMarker in val || createEndpoint in val
  ),
  serialize(obj, ep) {
    const capability = createEndpoint in obj
      ? CapabilityRegistry.getRemoteId(obj)
      : CapabilityRegistry.getId(obj);
    let port;
    if (createEndpoint in obj) {
      port = obj[createEndpoint]();
      if (isNativeMessagePort(ep) && isNativeConvertible(port)) {
        port = port[toNative]();
      } else if (ep[adoptNative] && isNativeMessagePort(port)) {
        port = ep[adoptNative](port);
      }
    } else {
      const { port1, port2 } = new (ep[messageChannel] ?? MessageChannel)();
      expose(obj, port1);
      port = port2;
    }
    return [{ capability, port }, [port]];
  },
  deserialize({ capability, port }, ep) {
    const local = capability ? CapabilityRegistry.getLocal(capability) : undefined;
    if (local) {
      // The capability completed a round trip. Return the original object and
      // close the redundant forwarding endpoint created by `createEndpoint`.
      port.close();
      return local as ProxyValue;
    }
    const cached = capability && CapabilityRegistry.getRemote(capability);
    if (cached) {
      // Repeatedly sending the same capability must preserve object identity,
      // just as passing the same object repeatedly within one realm does.
      port.close();
      return cached;
    }
    port.start();
    const remote = wrap(port) as Proxy;
    if (capability) {
      CapabilityRegistry.addRemote(capability, remote, port);
    }
    return remote;
  },
} satisfies TransferHandler<ProxyValue, ProxyWireValue>;

function toProxyWireValue(value: ProxyValue, ep: Endpoint): TransferableTuple<WireValue> {
  const [{ capability, port }, transfer] = proxyTransferHandler.serialize(value, ep);
  return [{ type: WireValueType.HANDLER, name: "proxy", value: port, capability }, transfer];
}

function fromProxyWireValue(value: HandlerWireValue, ep: Endpoint) {
  return proxyTransferHandler.deserialize({
    capability: value.capability,
    port: value.value as MessagePort,
  }, ep);
}

const tupleTransferHandler = {
  canHandle: (value): value is unknown[] => (
    Array.isArray(value) && tupleMarker in value
  ),
  serialize: (value, ep) => serializeMarkedContainer(value, () => processTuple(value, ep)),
  deserialize: (value, ep) => value.map(fromWireValue, ep),
} satisfies TransferHandler<unknown[], WireValue[]>;

const recordTransferHandler = {
  canHandle: (value): value is Record<string, unknown> => (
    isObject(value) && !Array.isArray(value) && recordMarker in value
  ),
  serialize: (value, ep) => serializeMarkedContainer(value, () => processRecord(value, ep)),
  deserialize: (value, ep) => Object.fromEntries(Object.entries(value).map(([key, wireValue]) => (
    [key, fromWireValue.call(ep, wireValue)]
  ))),
} satisfies TransferHandler<Record<string, unknown>, Record<string, WireValue>>;

const serializingMarkedContainers = new WeakSet<object>();

function serializeMarkedContainer<T>(value: object, serialize: () => TransferableTuple<T>) {
  if (serializingMarkedContainers.has(value)) {
    throw new TypeError('Caplink record/tuple containers cannot be cyclic');
  }
  serializingMarkedContainers.add(value);
  try {
    return serialize();
  } finally {
    serializingMarkedContainers.delete(value);
  }
}

interface ThrownValue {
  [throwMarker]: unknown; // just needs to be present
  value: unknown;
}

interface SerializedThrownValue {
  isError: boolean;
  value: unknown;
}

type ResolversMap<K, V> = Map<K, Omit<PromiseWithResolvers<V>, 'promise'>>;

type EndpointStatus = 'open' | 'releasing' | 'broken' | 'closed';

interface EndpointState {
  readonly resolvers: ResolversMap<RequestId, WireValue>;
  readonly listeners: AbortController;
  status: EndpointStatus;
  nextRequestId: number;
  proxyCount: number;
  owned: boolean;
  capability?: CapabilityId;
  failure?: Error | string;
  releasePromise?: Promise<void>;
}

const endpointState = new WeakMap<Endpoint, EndpointState>();

function rejectPending(state: EndpointState, error: unknown) {
  for (const { reject } of state.resolvers.values()) reject(error);
  state.resolvers.clear();
}

function finishEndpoint(ep: Endpoint, state: EndpointState, failure?: Error | string) {
  if (state.status === 'closed' || state.status === 'broken') return;
  state.status = failure ? 'broken' : 'closed';
  state.failure = failure ?? 'released';
  rejectPending(state, failure instanceof Error ? failure : new Error(failure ?? 'Endpoint released'));
  state.listeners.abort();
  CapabilityRegistry.forgetEndpoint(ep);
  disposeEndpoint(ep, state.owned);
}

/**
 * Internal transfer handler to handle thrown exceptions.
 */
const throwTransferHandler = {
  canHandle: (value): value is ThrownValue => throwMarker in value,
  serialize({ value }) {
    return [{ isError: value instanceof Error, value }, []];
  },
  deserialize({ isError, value }) {
    if (isError && !(value instanceof Error)) {
      const serialized = isObject(value) ? value : {};
      const message = 'message' in serialized && typeof serialized.message === 'string'
        ? serialized.message
        : '';
      value = Object.assign(new Error(message), serialized);
    }
    throw value;
  },
} satisfies TransferHandler<ThrownValue, SerializedThrownValue>;

/**
 * Allows customizing the serialization of certain values.
 */
export const transferHandlers: Map<
  string,
  TransferHandler<object|Function, unknown>
> = new Map<string, any>([
  ["proxy", proxyTransferHandler],
  ["throw", throwTransferHandler],
  ["tuple", tupleTransferHandler],
  ["record", recordTransferHandler],
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

function assertSafePath(path: readonly PropertyKey[]) {
  const forbidden = path.find((member) => forbiddenPathMembers.has(member));
  if (forbidden !== undefined) {
    throw new TypeError(`Caplink capability path denied: ${String(forbidden)}`);
  }
}

function resolvePath(object: any, path: readonly PropertyKey[]) {
  assertSafePath(path);
  return path.reduce((value, property) => value[property], object);
}

async function runDisposers(value: object): Promise<void> {
  const disposable = value as any;
  const dispose = 'dispose' in Symbol && Symbol.dispose in disposable
    ? disposable[Symbol.dispose]
    : undefined;
  const asyncDispose = 'asyncDispose' in Symbol && Symbol.asyncDispose in disposable
    ? disposable[Symbol.asyncDispose]
    : undefined;
  const finalize = finalizer in disposable && typeof disposable[finalizer] === 'function'
    ? disposable[finalizer]
    : undefined;
  // Run finalizers before acknowledging RELEASE so the caller knows that the
  // exported resource has actually been freed.
  dispose?.call(disposable);
  await asyncDispose?.call(disposable);
  finalize?.call(disposable);
}

export function expose(
  object: object,
  ep: Endpoint = globalThis as any,
  allowedOrigins: (string | RegExp)[] = ["*"]
) {
  if (
    !isObject(ep)
    || typeof ep.addEventListener !== 'function'
    || typeof ep.removeEventListener !== 'function'
    || typeof ep.postMessage !== 'function'
  ) {
    throw new TypeError('Invalid Caplink endpoint');
  }
  CapabilityRegistry.expose(object, ep);
  const listeners = new AbortController();
  const endpointClosed = () => {
    listeners.abort();
    void CapabilityRegistry.release(ep).catch(() => {
      // The peer has already gone, so cleanup failures cannot be reported to it.
    });
  };
  const callback = async (ev: MessageEvent<unknown>): Promise<void> => {
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
            const rawValue = resolvePath(obj, data.path);
            returnValue = rawValue;
          }
          break;
        case MessageType.SET:
          {
            assertSafePath(data.path);
            const parent = resolvePath(obj, data.path.slice(0, -1));
            parent[data.path.slice(-1)[0]] = fromWireValue.call(ep, data.value);
            returnValue = true;
          }
          break;
        case MessageType.APPLY:
          {
            const parent = resolvePath(obj, data.path.slice(0, -1));
            const rawValue = resolvePath(obj, data.path);
            const argumentList = data.argumentList.map(fromWireValue, ep);
            returnValue = rawValue.apply(parent, argumentList);
          }
          break;
        case MessageType.CONSTRUCT:
          {
            const rawValue = resolvePath(obj, data.path);
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
            returnValue = CapabilityRegistry.release(ep);
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
      const replyEndpoint = (ev.source ?? ep) as Endpoint;
      try {
        const [wireValue, transfer] = toWireValue.call(ep, returnValue);
        wireValue.id = id;
        replyEndpoint.postMessage(wireValue, { transfer });
      }
      catch {
        // Send Serialization Error To Caller
        const [wireValue, transfer] = toWireValue.call(ep, {
          value: new TypeError("Unserializable return value"),
          [throwMarker]: 0,
        });
        wireValue.id = id;
        replyEndpoint.postMessage(wireValue, { transfer });
      }
      finally {
        if (type === MessageType.RELEASE) {
          // detach and deactivate after sending release response above.
          listeners.abort();
          closeEndpoint(ep);
        }
      }
    }
  };
  ep.addEventListener('message', callback, { signal: listeners.signal });
  // If the endpoint gets closed on us without a release message, we treat it the same so as not to prevent resource cleanup.
  ep.addEventListener('close', endpointClosed, { signal: listeners.signal });
  ep.addEventListener('error', endpointClosed, { signal: listeners.signal });
  ep.start?.();
}

function isCloseable(endpoint: object): endpoint is { close(): void } {
  return 'close' in endpoint && typeof endpoint.close === 'function';
}

function hasTerminate(endpoint: object): endpoint is { terminate(): void } {
  return 'terminate' in endpoint && typeof endpoint.terminate === 'function';
}

function hasDispose(endpoint: object): endpoint is { [Symbol.dispose](): void } {
  return 'dispose' in Symbol && Symbol.dispose in endpoint && endpoint[Symbol.dispose] != null;
}

function closeEndpoint(endpoint: Endpoint) {
  if (isCloseable(endpoint)) endpoint.close();
}

function disposeEndpoint(endpoint: Endpoint, owned = false) {
  if (owned) {
    if (hasDispose(endpoint)) endpoint[Symbol.dispose]();
    else if (hasTerminate(endpoint)) endpoint.terminate();
  }
  if (isCloseable(endpoint)) return endpoint.close();
}

export function wrap<T>(ep: Endpoint, target?: object|null, options: WrapOptions = {}): Remote<T> {
  setupEndpoint(ep, options.owned ?? false);
  return createProxy<T>(ep, [], target) as any;
}

function throwIfProxyReleased(ep: Endpoint) {
  const state = endpointState.get(ep);
  if (state?.status === 'open') return;
  const failure = state?.failure;
  throw new Error(
    `Proxy has been released and is not useable${failure ? `: ${String(failure)}` : ''}`,
    failure instanceof Error ? { cause: failure } : {},
  );
}

function releaseEndpoint(ep: Endpoint): Promise<void> {
  const state = endpointState.get(ep);
  if (!state || state.status === 'closed' || state.status === 'broken') return Promise.resolve();
  if (state.releasePromise) return state.releasePromise;

  const acknowledgement = Promise.race([
    requestResponseMessage(ep, { type: MessageType.RELEASE }).then(fromWireValue.bind(ep)),
    new Promise<never>((_, rej) => setTimeout(rej, releaseConfig.timeout, new DOMException('Release timed out', 'TimeoutError'))),
  ]);
  state.status = 'releasing';
  CapabilityRegistry.forgetEndpoint(ep);
  return state.releasePromise = acknowledgement.then(() => undefined)
    .finally(() => finishEndpoint(ep, state));
}

const proxyFinalizers = "FinalizationRegistry" in globalThis
  ? new FinalizationRegistry<Endpoint>((ep) => {
      const state = endpointState.get(ep);
      if (state && --state.proxyCount === 0) void releaseEndpoint(ep).catch(() => {});
    })
  : undefined;

function registerProxy(proxy: object, ep: Endpoint) {
  if (!proxyFinalizers) return;
  endpointState.get(ep)!.proxyCount += 1;
  proxyFinalizers.register(proxy, ep, proxy);
}

function unregisterProxy(proxy: object, ep: Endpoint) {
  if (proxyFinalizers?.unregister(proxy)) endpointState.get(ep)!.proxyCount -= 1;
}

export interface WrapOptions {
  /** 
   * Indicates that the remote owns the endpoint, meaning it will attempt to terminate/dispose of it when the remote is disposed or gc'ed. 
   * Default true for `MessagePort`s and default false for `Worker`s. 
   */
  owned?: boolean;
}

function setupEndpoint(ep: Endpoint, owned = false) {
  const existing = endpointState.get(ep);
  if (existing) {
    if (owned) existing.owned = true;
    return;
  }

  const listeners = new AbortController();
  const state: EndpointState = {
    resolvers: new Map(), listeners, status: 'open', nextRequestId: 0, proxyCount: 0, owned,
  };
  endpointState.set(ep, state);
  ep.addEventListener('message', makeMessageHandler(state.resolvers), { signal: listeners.signal });
  ep.addEventListener('close', (ev: CloseEvent) => {
    finishEndpoint(ep, state, ev.reason || 'Endpoint closed');
  }, { signal: listeners.signal });
  ep.addEventListener('error', (ev: ErrorEvent) => {
    finishEndpoint(ep, state, ev.error instanceof Error ? ev.error : 'Endpoint errored');
  }, { signal: listeners.signal });
  ep.start?.();
}

function createProxy<T>(
  ep: Endpoint,
  path: PropertyKey[] = [],
  target?: object|null,
): Remote<T> {
  const proxy = new Proxy(target ?? function () {}, {
    get(_target, prop) {
      if (prop === Symbol.dispose) {
        return () => {
          unregisterProxy(proxy, ep);
          CapabilityRegistry.forget(proxy);
          // Synchronous disposal cannot observe an asynchronous release error.
          void releaseEndpoint(ep).catch(() => {});
        };
      }
      if (prop === Symbol.asyncDispose || prop === releaseProxy) {
        return async () => {
          unregisterProxy(proxy, ep);
          CapabilityRegistry.forget(proxy);
          await releaseEndpoint(ep);
        };
      }
      throwIfProxyReleased(ep);
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
      throwIfProxyReleased(ep);
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
      throwIfProxyReleased(ep);
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
      throwIfProxyReleased(ep);
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
      throwIfProxyReleased(ep);
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

function processRecord(
  argumentRecord: Record<string, unknown>,
  ep: Endpoint,
): TransferableTuple<Record<string, WireValue>> {
  const processed = Object.entries(argumentRecord).map(([key, value]) => {
    const [wireValue, transfers] = toWireValue.call(ep, value);
    return { key, transfers, wireValue };
  });
  return [
    Object.fromEntries(processed.map(({ key, wireValue }) => [key, wireValue])),
    processed.flatMap(({ transfers }) => transfers),
  ];
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

/** Clone an array while applying Caplink transfer handlers to each item. */
export function tuple<T extends readonly unknown[]>(value: T): T & TupleMarked<T> {
  Object.defineProperty(value, tupleMarker, { configurable: true, value: true });
  return value as T & TupleMarked<T>;
}

/** Clone an object while applying Caplink transfer handlers to each own enumerable property. */
export function record<T extends object>(value: T): T & RecordMarked<T> {
  Object.defineProperty(value, recordMarker, { configurable: true, value: true });
  return value as T & RecordMarked<T>;
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
        if (handler === proxyTransferHandler) {
          return toProxyWireValue(value as ProxyValue, this);
        }
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
    case WireValueType.HANDLER: {
      const handler = transferHandlers.get(value.name)!;
      return handler === proxyTransferHandler
        ? fromProxyWireValue(value, this)
        : handler.deserialize(value.value, this);
    }
    case WireValueType.RAW:
      return value.value;
  }
}

const isResponse = (value: WireValue | null): value is WireValue & { id: RequestId } => (
  typeof value?.id === 'number' && Object.hasOwn(value, 'value') && (
    value.type === WireValueType.RAW || (value.type === WireValueType.HANDLER && transferHandlers.has(value.name))
  )
);

const makeMessageHandler = (resolverMap: ResolversMap<RequestId, WireValue>) => (ev: MessageEvent<WireValue|null>) => {
  const { data } = ev;
  if (!isResponse(data)) return;
  const resolvers = resolverMap.get(data.id);
  if (!resolvers) return;
  resolverMap.delete(data.id);
  resolvers.resolve(data);
}

function requestResponseMessage(
  ep: Endpoint,
  msg: Message,
  transfer?: Transferable[]
): Promise<WireValue> {
  throwIfProxyReleased(ep);
  const state = endpointState.get(ep)!;
  const { promise, resolve, reject } = Promise.withResolvers<WireValue>();
  const id = ++state.nextRequestId;
  msg.id = id;
  state.resolvers.set(id, { resolve, reject });
  try {
    ep.postMessage(msg, transfer);
  } catch (error) {
    state.resolvers.delete(id);
    reject(error);
  }
  return promise;
}
