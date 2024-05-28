import * as Comlink from './src/comlink.ts';

function *gen() {
  yield 1;
  yield 2;
  yield 3;
}

export const fns = {
  gen,
  record() {
    return Comlink.record({
      prop: 'Hello',
      gen: gen(),
    });
  },
  tuple() {
    return Comlink.tuple(['Hello', gen()] as const)
  },
  customGen(): CustomGenerator<string> {
    throw Error("Not implemented")
  }
}

interface CustomGenerator<T = any> extends Generator<T> {
  foo(): string;
}


Comlink.expose(fns);