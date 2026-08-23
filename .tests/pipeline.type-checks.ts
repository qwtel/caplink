import * as Caplink from '../src/caplink.ts';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

interface Builder {
  add(amount: number): Builder;
  multiply(amount: number): Promise<Builder>;
  build(): number;
  readonly result: number;
}

interface Capability extends Caplink.ProxyMarked {
  invoke(): string;
}

interface Api {
  makeBuilder(start: number): Builder;
  makeCapability(): Capability;
  consume(value: number): void;
}

declare const endpoint: Caplink.Endpoint;
const remote = Caplink.wrapChain<Api>(endpoint);

const built = remote.makeBuilder(1).add(2).multiply(3).build();
type DirectChainResult = Expect<Equal<Awaited<typeof built>, number>>;

const property = remote.makeBuilder(1).add(2).result;
type DirectPropertyResult = Expect<Equal<Awaited<typeof property>, number>>;

const capability = remote.makeCapability();
type ProxiedFinalResult = Expect<Equal<Awaited<typeof capability>, Caplink.Remote<Capability>>>;

// Narrow pipelining intentionally does not turn pending results into argument capabilities.
// @ts-expect-error A full pipelining implementation would accept this pending result.
remote.consume(remote.makeBuilder(1).build());

export type PipelineTypeChecks = [
  DirectChainResult,
  DirectPropertyResult,
  ProxiedFinalResult,
];
