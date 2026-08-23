import { describe, expect, it } from 'bun:test';

import * as Caplink from '../src/caplink.ts';

describe('Caplink follow-up correctness', () => {
  it('restores a local callback returned over a wrap-only endpoint', async () => {
    // Separate module instances model the registries of separate JS realms.
    // @ts-expect-error Bun query imports intentionally create another module instance.
    const owner = await import('../src/caplink.ts?wrap-return-owner');
    // @ts-expect-error Bun query imports intentionally create another module instance.
    const consumer = await import('../src/caplink.ts?wrap-return-consumer');
    let remembered: any;
    const { port1, port2 } = new MessageChannel();
    owner.expose({
      bounce(value: unknown) {
        remembered = value;
        return value;
      },
      async releaseRemembered() {
        await remembered?.[Symbol.asyncDispose]();
        remembered = undefined;
      },
    }, port1);
    const remote = consumer.wrap(port2, undefined, { owned: true }) as any;
    const callback = () => 'called';

    const returned = await remote.bounce(callback);
    const preservedIdentity = returned === callback;

    if (!preservedIdentity) await returned[Symbol.asyncDispose]();
    await remote.releaseRemembered();
    await remote[Symbol.asyncDispose]();
    expect(preservedIdentity).toBeTrue();
  });

  it('restores a local capability after a multi-hop return over another endpoint', async () => {
    // @ts-expect-error Bun query imports intentionally create another module instance.
    const first = await import('../src/caplink.ts?multi-hop-first');
    // @ts-expect-error Bun query imports intentionally create another module instance.
    const second = await import('../src/caplink.ts?multi-hop-second');
    // @ts-expect-error Bun query imports intentionally create another module instance.
    const third = await import('../src/caplink.ts?multi-hop-third');
    let held: any;
    const secondToThird = new MessageChannel();
    third.expose({
      remember(value: unknown) { held = value; },
      async releaseHeld() { await held?.[Symbol.asyncDispose](); held = undefined; },
    }, secondToThird.port1);
    const thirdFromSecond = second.wrap(secondToThird.port2, undefined, { owned: true }) as any;
    const firstToSecond = new MessageChannel();
    second.expose({
      async forward(value: any) {
        await thirdFromSecond.remember(value);
        await value[Symbol.asyncDispose]();
      },
    }, firstToSecond.port1);
    const secondFromFirst = first.wrap(firstToSecond.port2, undefined, { owned: true }) as any;
    const firstToThird = new MessageChannel();
    third.expose({ take: () => held }, firstToThird.port1);
    const thirdFromFirst = first.wrap(firstToThird.port2, undefined, { owned: true }) as any;
    const callback = () => 'local';

    await secondFromFirst.forward(callback);
    const returned = await thirdFromFirst.take();
    const preservedIdentity = returned === callback;

    if (!preservedIdentity) await returned[Symbol.asyncDispose]();
    await thirdFromSecond.releaseHeld();
    await secondFromFirst[Symbol.asyncDispose]();
    await thirdFromFirst[Symbol.asyncDispose]();
    await thirdFromSecond[Symbol.asyncDispose]();
    expect(preservedIdentity).toBeTrue();
  });

  it('rejects malformed ENDPOINT values without corrupting exposure accounting', async () => {
    let disposals = 0;
    const { port1, port2 } = new MessageChannel();
    Caplink.expose({
      [Symbol.asyncDispose]: async () => { disposals += 1; },
    }, port1);
    const nextMessage = () => new Promise<any>((resolve) => {
      const handler = (event: MessageEvent) => {
        port2.removeEventListener('message', handler);
        resolve(event.data);
      };
      port2.addEventListener('message', handler);
      port2.start();
    });

    for (const [id, value] of [[1, null], [2, {}]] as const) {
      const invalidResponse = nextMessage();
      port2.postMessage({ id, type: 'ENDPOINT', value });
      expect((await invalidResponse).type).toBe('HANDLER');
    }

    const releaseResponse = nextMessage();
    port2.postMessage({ id: 3, type: 'RELEASE' });
    await releaseResponse;
    port2.close();

    expect(disposals).toBe(1);
  });
});
