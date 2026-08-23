import { describe, expect, it } from 'bun:test';

import * as Caplink from '../src/caplink.ts';

type Outcome<T> =
  | { state: 'pending' }
  | { state: 'fulfilled'; value: T }
  | { state: 'rejected'; reason: unknown };

function observe<T>(promise: Promise<T>) {
  let outcome: Outcome<T> = { state: 'pending' };
  void promise.then(
    (value) => { outcome = { state: 'fulfilled', value }; },
    (reason) => { outcome = { state: 'rejected', reason }; },
  );
  return () => outcome;
}

async function checkpoint() {
  await Promise.resolve();
  await Promise.resolve();
}

function controlledEndpoint() {
  const events = new EventTarget();
  const sent: any[] = [];
  const endpoint: Caplink.Endpoint = {
    addEventListener: events.addEventListener.bind(events) as Caplink.Endpoint['addEventListener'],
    removeEventListener: events.removeEventListener.bind(events) as Caplink.Endpoint['removeEventListener'],
    postMessage(message) { sent.push(message); },
  };
  const emitMessage = (data: unknown) => {
    events.dispatchEvent(new MessageEvent('message', { data }));
  };
  const emitLifecycle = (type: 'close' | 'error', property: 'reason' | 'error', value: unknown) => {
    const event = new Event(type);
    Object.defineProperty(event, property, { value });
    events.dispatchEvent(event);
  };
  return {
    endpoint,
    sent,
    emitMessage,
    emitClose: (reason = 'Endpoint closed') => emitLifecycle('close', 'reason', reason),
    emitError: (error: Error) => emitLifecycle('error', 'error', error),
  };
}

function duplexEndpoint(port: MessagePort) {
  const sent: any[] = [];
  const endpoint: Caplink.Endpoint & { close(): void } = {
    addEventListener: port.addEventListener.bind(port),
    removeEventListener: port.removeEventListener.bind(port),
    postMessage(message, transfer) {
      sent.push(message);
      port.postMessage(message, transfer as StructuredSerializeOptions);
    },
    start: port.start.bind(port),
    close: port.close.bind(port),
  };
  return { endpoint, sent };
}

function connectDuplex(leftApi: object, rightApi: object) {
  const channel = new MessageChannel();
  const left = duplexEndpoint(channel.port1);
  const right = duplexEndpoint(channel.port2);
  Caplink.expose(leftApi, left.endpoint);
  Caplink.expose(rightApi, right.endpoint);
  const rightFromLeft = Caplink.wrap<any>(left.endpoint);
  const leftFromRight = Caplink.wrap<any>(right.endpoint);
  return {
    left,
    right,
    rightFromLeft,
    leftFromRight,
    close() {
      left.endpoint.close();
      right.endpoint.close();
    },
  };
}

describe('Caplink protocol message classes', () => {
  it('does not settle a pending response with an incoming request carrying the same ID', async () => {
    const controlled = controlledEndpoint();
    const remote = Caplink.wrap<any>(controlled.endpoint);
    const pending = remote.localRequest();
    const outcome = observe(pending);

    expect(controlled.sent[0].id).toBe(1);
    for (const type of ['GET', 'SET', 'APPLY', 'CONSTRUCT', 'ENDPOINT', 'RELEASE']) {
      controlled.emitMessage({ id: 1, type, path: [], argumentList: [] });
    }
    await checkpoint();
    expect(outcome()).toEqual({ state: 'pending' });

    controlled.emitMessage({ id: 1, type: 'RAW', value: 'actual response' });
    await expect(pending).resolves.toBe('actual response');
    controlled.emitClose();
  });

  it('allows both peers to allocate request ID 1 concurrently on one duplex endpoint', async () => {
    const connection = connectDuplex(
      { identify: (value: string) => `left:${value}` },
      { identify: (value: string) => `right:${value}` },
    );
    try {
      await expect(Promise.all([
        connection.rightFromLeft.identify('from-left'),
        connection.leftFromRight.identify('from-right'),
      ])).resolves.toEqual(['right:from-left', 'left:from-right']);

      const leftRequests = connection.left.sent.filter(({ type }) => type === 'APPLY');
      const rightRequests = connection.right.sent.filter(({ type }) => type === 'APPLY');
      expect(leftRequests.map(({ id }) => id)).toEqual([1]);
      expect(rightRequests.map(({ id }) => id)).toEqual([1]);
    } finally {
      connection.close();
    }
  });

  it('ignores unknown IDs, unknown response types, and non-response messages', async () => {
    const controlled = controlledEndpoint();
    const remote = Caplink.wrap<any>(controlled.endpoint);
    const pending = remote.value();
    const outcome = observe(pending);

    for (const message of [
      null,
      {},
      { id: '1', type: 'RAW', value: 'wrong ID type' },
      { id: 999, type: 'RAW', value: 'unknown ID' },
      { id: 1, type: 'UNKNOWN', value: 'unknown response type' },
      { id: 1, type: 'GET', path: [] },
    ]) controlled.emitMessage(message);
    await checkpoint();
    expect(outcome()).toEqual({ state: 'pending' });

    controlled.emitMessage({ id: 1, type: 'RAW', value: 'valid' });
    await expect(pending).resolves.toBe('valid');
    controlled.emitClose();
  });

  it('does not dispatch response-class messages as exposed requests', async () => {
    const controlled = controlledEndpoint();
    let reads = 0;
    Caplink.expose({
      get value() {
        reads++;
        return 'value';
      },
    }, controlled.endpoint);

    for (const message of [
      { id: 1, type: 'RAW', value: 'response' },
      { id: 1, type: 'HANDLER', name: 'proxy', value: null },
      { id: 1, type: 'UNKNOWN', path: ['value'] },
    ]) controlled.emitMessage(message);
    await checkpoint();

    expect(reads).toBe(0);
    expect(controlled.sent).toEqual([]);
    controlled.emitClose();
  });

  it('ignores structurally malformed RAW responses without consuming the resolver', async () => {
    const controlled = controlledEndpoint();
    const remote = Caplink.wrap<any>(controlled.endpoint);
    const pending = remote.value();
    const outcome = observe(pending);

    controlled.emitMessage({ id: 1, type: 'RAW' });
    await checkpoint();
    expect(outcome()).toEqual({ state: 'pending' });

    controlled.emitMessage({ id: 1, type: 'RAW', value: 'valid' });
    await expect(pending).resolves.toBe('valid');
    controlled.emitClose();
  });

  for (const [description, malformed] of [
    ['missing handler name', { id: 1, type: 'HANDLER', value: null }],
    ['unregistered handler name', { id: 1, type: 'HANDLER', name: 'not-registered', value: null }],
  ] as const) {
    it(`ignores a HANDLER response with ${description} without consuming the resolver`, async () => {
      const controlled = controlledEndpoint();
      const remote = Caplink.wrap<any>(controlled.endpoint);
      const pending = remote.value();
      const outcome = observe(pending);

      controlled.emitMessage(malformed);
      await checkpoint();
      expect(outcome()).toEqual({ state: 'pending' });

      controlled.emitMessage({ id: 1, type: 'RAW', value: 'valid' });
      await expect(pending).resolves.toBe('valid');
      controlled.emitClose();
    });
  }

  it('settles exactly one request for each valid response and ignores duplicates', async () => {
    const controlled = controlledEndpoint();
    const remote = Caplink.wrap<any>(controlled.endpoint);
    const first = remote.first();
    const second = remote.second();
    const firstOutcome = observe(first);
    const secondOutcome = observe(second);

    controlled.emitMessage({ id: 1, type: 'RAW', value: 'first' });
    controlled.emitMessage({ id: 1, type: 'RAW', value: 'duplicate' });
    await checkpoint();
    expect(firstOutcome()).toEqual({ state: 'fulfilled', value: 'first' });
    expect(secondOutcome()).toEqual({ state: 'pending' });

    controlled.emitMessage({ id: 2, type: 'RAW', value: 'second' });
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    controlled.emitClose();
  });

  it('correlates a larger deterministic out-of-order response permutation', async () => {
    const controlled = controlledEndpoint();
    const remote = Caplink.wrap<any>(controlled.endpoint);
    const pending = Array.from({ length: 8 }, (_, value) => remote.echo(value));

    for (const id of [6, 2, 8, 1, 7, 3, 5, 4]) {
      controlled.emitMessage({ id, type: 'RAW', value: id - 1 });
    }

    await expect(Promise.all(pending)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    controlled.emitClose();
  });
});

describe('Caplink protocol failure fan-out', () => {
  for (const kind of ['close', 'error'] as const) {
    it(`rejects every pending request on endpoint ${kind}`, async () => {
      const controlled = controlledEndpoint();
      const remote = Caplink.wrap<any>(controlled.endpoint);
      const pending = [remote.first(), remote.second(), remote.third()];
      const failure = new Error(`${kind} failure`);

      if (kind === 'close') controlled.emitClose(failure.message);
      else controlled.emitError(failure);

      const outcomes = await Promise.all(pending.map((promise) => promise.catch((error: unknown) => error)));
      expect(outcomes.every((outcome) => outcome instanceof Error)).toBeTrue();
      if (kind === 'error') expect(outcomes.every((outcome) => outcome === failure)).toBeTrue();
    });
  }
});

describe('Caplink concurrent protocol routes', () => {
  it('runs bidirectional callbacks and nested callbacks while root IDs collide', async () => {
    const makeApi = (label: string) => ({
      async invoke(callback: any) {
        const nested = (value: string) => `${label}:nested:${value}`;
        try {
          return await callback(`${label}:outer`, nested);
        } finally {
          // A same-process peer may recover the original capability rather than a proxy.
          await callback[Symbol.asyncDispose]?.();
        }
      },
    });
    const connection = connectDuplex(makeApi('left'), makeApi('right'));
    const useCallback = async (outer: string, nested: any) => {
      try {
        return [outer, await nested('value')];
      } finally {
        await nested[Symbol.asyncDispose]?.();
      }
    };
    try {
      const results = await Promise.all([
        connection.rightFromLeft.invoke(useCallback),
        connection.leftFromRight.invoke(useCallback),
      ]);
      expect(results).toEqual([
        ['right:outer', 'right:nested:value'],
        ['left:outer', 'left:nested:value'],
      ]);
    } finally {
      connection.close();
    }
  });

  it('runs root requests through simultaneous endpoint handoffs in both directions', async () => {
    const connection = connectDuplex(
      { identify: (value: string) => `left:${value}` },
      { identify: (value: string) => `right:${value}` },
    );
    const rightFork = Caplink.wrap<any>(connection.rightFromLeft[Caplink.createEndpoint](), undefined, { owned: true });
    const leftFork = Caplink.wrap<any>(connection.leftFromRight[Caplink.createEndpoint](), undefined, { owned: true });
    try {
      await expect(Promise.all([
        connection.rightFromLeft.identify('root'),
        connection.leftFromRight.identify('root'),
        rightFork.identify('fork'),
        leftFork.identify('fork'),
      ])).resolves.toEqual([
        'right:root',
        'left:root',
        'right:fork',
        'left:fork',
      ]);
    } finally {
      await Promise.allSettled([
        rightFork[Symbol.asyncDispose](),
        leftFork[Symbol.asyncDispose](),
      ]);
      connection.close();
    }
  });
});
