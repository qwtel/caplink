import { describe, expect, it } from 'bun:test';

import * as Caplink from '../src/caplink.ts';

// Separate module instances provide separate realm-wide capability registries.
// @ts-expect-error Bun query imports intentionally create another module instance.
const identityOwner = await import('../src/caplink.ts?state-identity-owner');
// @ts-expect-error Bun query imports intentionally create another module instance.
const identityConsumer = await import('../src/caplink.ts?state-identity-consumer');

function connect<T extends object>(api: T) {
  const { port1, port2 } = new MessageChannel();
  Caplink.expose(api, port1);
  return { port1, port2, remote: Caplink.wrap<any>(port2, undefined, { owned: true }) };
}

function connectIdentityRealms<T extends object>(api: T) {
  const { port1, port2 } = new MessageChannel();
  identityOwner.expose(api, port1);
  return identityConsumer.wrap(port2, undefined, { owned: true }) as any;
}

type Respond = (message: any, value?: unknown) => void;
type OnPost = (message: any, respond: Respond) => void;

function controlledEndpoint(
  onPost: OnPost = (message, respond) => respond(message, message.argumentList?.[0]?.value),
) {
  const events = new EventTarget();
  const sent: any[] = [];
  const lifecycle = { closes: 0, disposals: 0 };
  const respond: Respond = (message, value) => queueMicrotask(() => {
    events.dispatchEvent(new MessageEvent('message', {
      data: { id: message.id, type: 'RAW', value },
    }));
  });
  const endpoint: Caplink.Endpoint & { close(): void; [Symbol.dispose](): void } = {
    addEventListener: events.addEventListener.bind(events) as Caplink.Endpoint['addEventListener'],
    removeEventListener: events.removeEventListener.bind(events) as Caplink.Endpoint['removeEventListener'],
    postMessage(message) {
      sent.push(message);
      onPost(message, respond);
    },
    close() { lifecycle.closes += 1; },
    [Symbol.dispose]() { lifecycle.disposals += 1; },
  };
  const dispatch = (type: 'close' | 'error', property: string, value: unknown) => {
    const event = new Event(type);
    Object.defineProperty(event, property, { value });
    events.dispatchEvent(event);
  };
  return {
    endpoint,
    lifecycle,
    sent,
    emitClose: (reason = 'Endpoint closed') => dispatch('close', 'reason', reason),
    emitError: (error: Error) => dispatch('error', 'error', error),
  };
}

function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error) => error);
}

describe('Caplink request correlation', () => {
  it('uses non-zero monotonic IDs and correlates out-of-order responses', async () => {
    const requests: any[] = [];
    const controlled = controlledEndpoint((message, respond) => {
      if (message.type === 'RELEASE') return respond(message);
      requests.push(message);
      if (requests.length === 3) {
        for (const request of requests.toReversed()) {
          respond(request, request.argumentList[0].value);
        }
      }
    });
    const remote = Caplink.wrap<any>(controlled.endpoint);

    expect(await Promise.all([remote(1), remote(2), remote(3)])).toEqual([1, 2, 3]);
    expect(requests.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(requests.every(({ id }) => id > 0)).toBeTrue();
    await remote[Symbol.asyncDispose]();
  });

  it('allocates IDs independently for each endpoint', async () => {
    const first = controlledEndpoint();
    const second = controlledEndpoint();
    const firstRemote = Caplink.wrap<any>(first.endpoint);
    const secondRemote = Caplink.wrap<any>(second.endpoint);

    await Promise.all([firstRemote('first'), secondRemote('second')]);

    expect(first.sent[0].id).toBe(1);
    expect(second.sent[0].id).toBe(1);
    await Promise.all([
      firstRemote[Symbol.asyncDispose](),
      secondRemote[Symbol.asyncDispose](),
    ]);
  });

  it('remains usable after a synchronous postMessage failure', async () => {
    let fail = true;
    const controlled = controlledEndpoint((message, respond) => {
      if (message.type === 'RELEASE') return respond(message);
      if (fail) {
        fail = false;
        throw new DOMException('could not clone', 'DataCloneError');
      }
      respond(message, 'recovered');
    });
    const remote = Caplink.wrap<any>(controlled.endpoint);

    await expect(remote()).rejects.toThrow('could not clone');
    await expect(remote()).resolves.toBe('recovered');
    expect(controlled.sent.slice(0, 2).map(({ id }) => id)).toEqual([1, 2]);
    await remote[Symbol.asyncDispose]();
  });
});

describe('Caplink endpoint lifecycle', () => {
  it('rejects every outstanding request when the endpoint closes', async () => {
    const controlled = controlledEndpoint(() => {});
    const remote = Caplink.wrap<any>(controlled.endpoint);
    const errors = Promise.all([captureError(remote.first()), captureError(remote.second())]);

    controlled.emitClose();

    for (const error of await errors) expect(error).toBeInstanceOf(Error);
    expect(() => remote.third()).toThrow('Proxy has been released');
  });

  it('preserves a transport error as the failure and proxy cause', async () => {
    const controlled = controlledEndpoint(() => {});
    const remote = Caplink.wrap<any>(controlled.endpoint);
    const cause = new Error('transport failed');
    const requestError = captureError(remote.pending());
    const sibling = remote.sibling;

    controlled.emitError(cause);

    expect(await requestError).toBe(cause);
    try {
      void sibling.value;
      throw new Error('expected sibling access to throw');
    } catch (error) {
      expect((error as Error).cause).toBe(cause);
    }
  });

  it('invalidates every sibling proxy when any path is released', async () => {
    const { remote } = connect({ left: { value: 1 }, right: { value: 2 } });
    const left = remote.left;
    const right = remote.right;

    await left[Symbol.asyncDispose]();

    expect(() => remote.left).toThrow('Proxy has been released');
    expect(() => right.value).toThrow('Proxy has been released');
  });

  it('sends RELEASE only once across repeated and sibling disposal', async () => {
    const controlled = controlledEndpoint();
    const remote = Caplink.wrap<any>(controlled.endpoint);
    const sibling = remote.sibling;

    await Promise.all([
      remote[Symbol.asyncDispose](),
      sibling[Symbol.asyncDispose](),
      remote[Caplink.releaseProxy](),
    ]);

    expect(controlled.sent.filter(({ type }) => type === 'RELEASE')).toHaveLength(1);
  });

  it('rejects other pending calls after an acknowledged release', async () => {
    const controlled = controlledEndpoint((message, respond) => {
      if (message.type === 'RELEASE') respond(message);
    });
    const remote = Caplink.wrap<any>(controlled.endpoint);
    const pendingError = captureError(remote.slow());

    await remote[Symbol.asyncDispose]();

    expect(await pendingError).toBeInstanceOf(Error);
  });

  it('settles async disposal when the transport closes before its acknowledgement', async () => {
    const controlled = controlledEndpoint(() => {});
    const remote = Caplink.wrap<any>(controlled.endpoint);
    const releaseError = captureError(remote[Symbol.asyncDispose]());

    controlled.emitClose('closed during release');

    expect((await releaseError as Error).message).toContain('closed during release');
  });

  it('times out async disposal when RELEASE is never acknowledged', async () => {
    const previousTimeout = Caplink.releaseConfig.timeout;
    Caplink.releaseConfig.timeout = 0;
    try {
      const controlled = controlledEndpoint(() => {});
      const remote = Caplink.wrap<any>(controlled.endpoint);

      expect((await captureError(remote[Symbol.asyncDispose]()) as Error).name).toBe('TimeoutError');
      expect(controlled.lifecycle.closes).toBe(1);
      expect(() => remote.value).toThrow('Proxy has been released');
    } finally {
      Caplink.releaseConfig.timeout = previousTimeout;
    }
  });

  it('retains endpoint ownership when disposing through a child path', async () => {
    const owned = controlledEndpoint();
    const unowned = controlledEndpoint();
    const ownedRemote = Caplink.wrap<any>(owned.endpoint, undefined, { owned: true });
    const unownedRemote = Caplink.wrap<any>(unowned.endpoint);

    await ownedRemote.child[Symbol.asyncDispose]();
    await unownedRemote.child[Symbol.asyncDispose]();

    expect(owned.lifecycle).toEqual({ closes: 1, disposals: 1 });
    expect(unowned.lifecycle).toEqual({ closes: 1, disposals: 0 });
  });
});

describe('Caplink export lifecycle', () => {
  it('awaits asynchronous disposal before acknowledging RELEASE', async () => {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let disposed = false;
    const { remote } = connect({
      [Symbol.asyncDispose]: async () => {
        started.resolve();
        await gate.promise;
        disposed = true;
      },
    });

    const release = remote[Symbol.asyncDispose]();
    await started.promise;
    expect(disposed).toBeFalse();
    gate.resolve();
    await release;
    expect(disposed).toBeTrue();
  });

  it('propagates an asynchronous disposal failure', async () => {
    const { remote } = connect({
      [Symbol.asyncDispose]: async () => { throw new Error('dispose failed'); },
    });

    await expect(remote[Symbol.asyncDispose]()).rejects.toThrow('dispose failed');
    expect(() => remote.value).toThrow('Proxy has been released');
  });

  it('keeps deprecated releaseProxy awaitable and error-preserving', async () => {
    const { remote } = connect({
      [Symbol.asyncDispose]: async () => { throw new Error('legacy release failed'); },
    });

    const release = remote[Caplink.releaseProxy]();
    expect(release).toBeInstanceOf(Promise);
    await expect(release).rejects.toThrow('legacy release failed');
  });

  it('makes synchronous disposal immediately visible to sibling proxies', async () => {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const { remote } = connect({
      value: 1,
      [Symbol.asyncDispose]: async () => {
        started.resolve();
        await gate.promise;
        finished.resolve();
      },
    });
    const sibling = remote.value;

    remote[Symbol.dispose]();

    expect(() => sibling.other).toThrow('Proxy has been released');
    await started.promise;
    gate.resolve();
    await finished.promise;
  });

  it('runs standard and legacy disposers in a defined order', async () => {
    const order: string[] = [];
    const { remote } = connect({
      [Symbol.dispose]: () => { order.push('dispose'); },
      [Symbol.asyncDispose]: async () => { order.push('asyncDispose'); },
      [Caplink.finalizer]: () => { order.push('finalizer'); },
    });

    await remote[Symbol.asyncDispose]();

    expect(order).toEqual(['dispose', 'asyncDispose', 'finalizer']);
  });

  it('disposes an object only after its last exposure is released', async () => {
    let disposals = 0;
    const api = { [Symbol.asyncDispose]: async () => { disposals += 1; } };
    const first = new MessageChannel();
    const second = new MessageChannel();
    Caplink.expose(api, first.port1);
    Caplink.expose(api, second.port1);
    const firstRemote = Caplink.wrap<any>(first.port2);
    const secondRemote = Caplink.wrap<any>(second.port2);

    await firstRemote[Symbol.asyncDispose]();
    expect(disposals).toBe(0);
    await secondRemote[Symbol.asyncDispose]();
    expect(disposals).toBe(1);
  });

  it('finalizes exactly once when close and error both arrive', async () => {
    let disposals = 0;
    const controlled = controlledEndpoint(() => {});
    Caplink.expose({ [Symbol.asyncDispose]: async () => { disposals += 1; } }, controlled.endpoint);

    controlled.emitError(new Error('failed'));
    controlled.emitClose();
    await Promise.resolve();

    expect(disposals).toBe(1);
  });

  it('does not allow an endpoint to expose two objects', () => {
    const controlled = controlledEndpoint(() => {});
    Caplink.expose({}, controlled.endpoint);

    expect(() => Caplink.expose({}, controlled.endpoint)).toThrow('cannot be reused');
    controlled.emitClose();
  });
});

describe('Caplink capability identity', () => {
  it('deduplicates repeated imports by capability ID', async () => {
    const capability = identityOwner.proxy({ value: 'original' });
    const remote = connectIdentityRealms({ capability: () => capability });

    const first = await remote.capability();
    const second = await remote.capability();
    expect(second).toBe(first);

    await first[Symbol.asyncDispose]();
    await remote[Symbol.asyncDispose]();
  });

  it('evicts an import when a nested proxy releases its endpoint', async () => {
    const capability = identityOwner.proxy({ value: 'original' });
    const remote = connectIdentityRealms({ capability: () => capability });
    const first = await remote.capability();

    await first.unusedPath[Symbol.asyncDispose]();
    const replacement = await remote.capability();

    expect(replacement).not.toBe(first);
    expect(await replacement.value).toBe('original');
    await replacement[Symbol.asyncDispose]();
    await remote[Symbol.asyncDispose]();
  });

  it('restores a capability that returns to its owning realm', async () => {
    const capability = identityOwner.proxy({ value: 'original' });
    const remote = connectIdentityRealms({
      capability: () => capability,
      isOriginal: (value: unknown) => value === capability,
    });

    const returned = await remote.capability();

    expect(await remote.isOriginal(returned)).toBeTrue();
    await returned[Symbol.asyncDispose]();
    await remote[Symbol.asyncDispose]();
  });
});
