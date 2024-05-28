// deno-lint-ignore-file ban-ts-comment ban-unused-ignore
import * as Comlink from './src/comlink.ts';
import type { fns } from "./playground-worker.ts"

const w = new Worker(new URL("./playground-worker.ts", import.meta.url), { type: "module" });

const fn = async () => {
  await using remote = Comlink.wrap<typeof fns>(w);

  // await using x = remote.gen() as Comlink.Remote<ReturnType<typeof remote.gen>>;
  // const rc = await remote.getRecord()
  // await using x = remote.gen() as any;
  // await using gen = remote.gen();
  await using gen = remote.gen();

  try {
    console.log("RECVD", await gen.next())
    console.log("RECVD", await gen.next("a"))
    // await gen.throw(new Error())
    console.log("RECVD", await gen.next("b"))
    console.log("RECVD", await gen.next("c"))
  } finally {
    await gen.return();
  }

  await using gen2 = remote.gen();
  for await (const value of gen2) console.log("RECVD", value)

  const it2 = gen2[Symbol.asyncIterator]()
  // const it1 = gen2[Symbol.iterator]?.()
  for await (const value of it2) console.log("RECV2", { value })

  const remoteRec = await remote.record()
  await using pgen = remoteRec.gen;
  console.log("APROP", remoteRec.prop)

  // if ('gc' in self && typeof self.gc === "function") {
  //   for await (const value of pgen) console.log("RECVD", { value });
  //   self.gc();
  // } else {
  //   await using iter = pgen[Symbol.asyncIterator]();
  //   for await (const value of iter) console.log("RECVD", { value })
  // }

  // await using cgen = remote.getCustomGen()
  // const foos = await cgen.foo()
  // await cgen.next();
  // for await (const value of cgen) console.log("RECVD", { value })
}

// await fn();
// w.terminate();

Deno.test({
  name: "test",
  fn,
})

