# Comlink Plus

A fork of [Comlink](https://github.com/GoogleChromeLabs/comlink) that adds missing support for generators and multiple return values.

## Tuples & Records
By default, Comlink's transfer handlers only apply to arguments and return values of functions. 
Comlink Plus relaxes this by providing `Comlink.tuple` and `Comlink.record` helpers that apply transfer handlers, including user-defined ones, to each immediate member, e.g.

```ts
Comlink.transferHandlers.set("myclass", { /* ... */ })

Comlink.expose({
  // Works in upstream:
  doSomething(foo: MyClass) { /* ... */ }
  // Not working in upstream:
  doSomethingNew(options: { prop: MyClass }) { /* ... */ }
})

```
```ts
// Main thread
worker.doSomething(new MyClass())

// Fixed in comlink-plus:
worker.doSomethingNew(Comlink.record({ prop: new MyClass() }))
```

## Generators
Generator support works as you would expect, turning sync generators into async versions. 
It can be combined with record & tuple to return meta data along with a generator:

```js
Comlink.expose({
  *gen() {
    yield 1;
    yield 2;
    yield 3;
  },
  getRecord() {
    return Comlink.record({
      prop: 'Hello',
      gen: this.gen(),
    });
  },
  getTuple() {
    return Comlink.tuple(['Hello', this.gen()])
  },
});
```
```ts
// Main thread
for await (const x of worker.gen()) {
  console.log(x) // 1,2,3
}

const { gen } = await worker.getRecord();
for await (const x of gen) {
  console.log(x) // 1,2,3
}

const [ , gen2 ] = await worker.getTuple();
for await (const x of gen2) {
  console.log(x) // 1,2,3
}
```

- Only (async) generators will be transferred, no unnecessary work is being done for e.g. arrays or other types that define `Symbol.iterator` but aren't expected to be async-ified
- `yield`, `return` and `throw` values are passed through Comlink's wire protocol (custom transfer handler support!)
- Can push values to the generator by calling `next` manually. These values are also passed through Comlink's wire protocol.
- Updated TS types (best effort basis)
- Worker is notified when consumer generator is garbage collected

## Promises
Also adds support for sending promises, making the following pattern possible. 
Previously this would have required splitting into 2 methods and maintaining state manually.

```ts
Comlink.expose({
  doWork(promise: Promise<any>) {
    doSetupWork();
    const x = await promise;
    continueWork(x);
  },
});
```
```ts
// Main thread
await worker.doWork(new Promise(r => setTimeout(r, 100)))
```


