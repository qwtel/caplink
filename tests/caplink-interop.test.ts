import { afterAll, describe, expect, it } from 'bun:test';

import * as Caplink from '../src/caplink.ts';
import { loadUpstreamComlink } from './upstream-comlink.ts';

const upstream = await loadUpstreamComlink();
const Comlink = upstream.Comlink as any;
afterAll(upstream.cleanup);

function connect(exposer: any, caller: any, api: object) {
  const { port1, port2 } = new MessageChannel();
  exposer.expose(api, port1);
  return {
    remote: caller.wrap(port2) as any,
    close() {
      port1.close();
      port2.close();
    },
  };
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('Comlink 4.4.2 interoperability', () => {
  for (const [label, exposer, caller] of [
    ['Caplink calling Comlink', Comlink, Caplink],
    ['Comlink calling Caplink', Caplink, Comlink],
  ] as const) {
    it(`${label}: cloneable values and transferables`, async () => {
      const connection = connect(exposer, caller, {
        value: 3,
        add(a: number, b: number) { return a + b; },
        async echo(value: unknown) { return value; },
        inspect(buffer: ArrayBuffer) {
          return { length: buffer.byteLength, first: new Uint8Array(buffer)[0] };
        },
        makeBuffer() {
          const buffer = new Uint8Array([13, 21]).buffer;
          return exposer.transfer(buffer, [buffer]);
        },
      });
      try {
        expect(await connection.remote.value).toBe(3);
        expect(await connection.remote.add(2, 5)).toBe(7);
        expect(await connection.remote.echo({ nested: ['raw', 8] })).toEqual({ nested: ['raw', 8] });

        connection.remote.value = 11;
        expect(await connection.remote.value).toBe(11);

        const outgoing = new Uint8Array([8, 5, 3]).buffer;
        expect(await connection.remote.inspect(caller.transfer(outgoing, [outgoing]))).toEqual({
          length: 3,
          first: 8,
        });
        expect(outgoing.byteLength).toBe(0);
        expect(new Uint8Array(await connection.remote.makeBuffer())).toEqual(new Uint8Array([13, 21]));
      } finally {
        connection.close();
      }
    });

    it(`${label}: errors and thrown values`, async () => {
      const connection = connect(exposer, caller, {
        fail() { throw new TypeError(`${label} failure`); },
        failWithValue() { throw `${label} value`; },
      });
      try {
        await expect(connection.remote.fail()).rejects.toThrow(`${label} failure`);
        expect(await connection.remote.failWithValue().catch((value: unknown) => value)).toBe(`${label} value`);
      } finally {
        connection.close();
      }
    });
  }

  it('passes a Caplink callback to Comlink', async () => {
    const connection = connect(Comlink, Caplink, {
      async invoke(callback: any, value: number) {
        try {
          return await callback(value);
        } finally {
          callback[Comlink.releaseProxy]();
        }
      },
    });
    try {
      expect(await connection.remote.invoke((value: number) => value * 2, 6)).toBe(12);
    } finally {
      connection.close();
    }
  });

  it('passes a Comlink callback to Caplink', async () => {
    const connection = connect(Caplink, Comlink, {
      async invoke(callback: any, value: number) {
        try {
          return await callback(value);
        } finally {
          await callback[Symbol.asyncDispose]();
        }
      },
    });
    try {
      const callback = Comlink.proxy((value: number) => value * 2);
      expect(await connection.remote.invoke(callback, 6)).toBe(12);
    } finally {
      connection.close();
    }
  });

  it('receives an upstream proxy in Caplink', async () => {
    const connection = connect(Comlink, Caplink, {
      counter() {
        let value = 4;
        return Comlink.proxy({ increment: () => ++value });
      },
    });
    try {
      const counter = await connection.remote.counter();
      expect(await counter.increment()).toBe(5);
      await counter[Symbol.asyncDispose]();
    } finally {
      connection.close();
    }
  });

  it('receives a Caplink capability in Comlink', async () => {
    const connection = connect(Caplink, Comlink, {
      counter() {
        let value = 4;
        return Caplink.proxy({ increment: () => ++value });
      },
    });
    try {
      const counter = await connection.remote.counter();
      expect(await counter.increment()).toBe(5);
      counter[Comlink.releaseProxy]();
      await nextTask();
    } finally {
      connection.close();
    }
  });

  it('runs callbacks and nested callbacks concurrently in both interop directions', async () => {
    const caplinkCallingComlink = connect(Comlink, Caplink, {
      async invoke(callback: any) {
        try {
          return await callback('Comlink:outer', Comlink.proxy((value: string) => `Comlink:nested:${value}`));
        } finally {
          callback[Comlink.releaseProxy]();
        }
      },
    });
    const comlinkCallingCaplink = connect(Caplink, Comlink, {
      async invoke(callback: any) {
        try {
          return await callback('Caplink:outer', (value: string) => `Caplink:nested:${value}`);
        } finally {
          await callback[Symbol.asyncDispose]();
        }
      },
    });
    const caplinkCallback = async (outer: string, nested: any) => {
      try {
        return [outer, await nested('value')];
      } finally {
        await nested[Symbol.asyncDispose]();
      }
    };
    const comlinkCallback = Comlink.proxy(async (outer: string, nested: any) => {
      try {
        return [outer, await nested('value')];
      } finally {
        nested[Comlink.releaseProxy]();
      }
    });

    try {
      await expect(Promise.all([
        caplinkCallingComlink.remote.invoke(caplinkCallback),
        comlinkCallingCaplink.remote.invoke(comlinkCallback),
      ])).resolves.toEqual([
        ['Comlink:outer', 'Comlink:nested:value'],
        ['Caplink:outer', 'Caplink:nested:value'],
      ]);
      await nextTask();
    } finally {
      caplinkCallingComlink.close();
      comlinkCallingCaplink.close();
    }
  });

  for (const [label, exposer, caller, release] of [
    ['Caplink constructing an upstream class', Comlink, Caplink, Symbol.asyncDispose],
    ['Comlink constructing a Caplink class', Caplink, Comlink, Comlink.releaseProxy],
  ] as const) {
    it(label, async () => {
      class Counter {
        constructor(private value: number) {}
        increment() { return ++this.value; }
      }
      const connection = connect(exposer, caller, { Counter });
      try {
        const counter = await new connection.remote.Counter(4);
        expect(await counter.increment()).toBe(5);
        await counter[release]();
        await nextTask();
      } finally {
        connection.close();
      }
    });
  }
});
