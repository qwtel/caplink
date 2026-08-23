import * as Caplink from '../src/caplink.ts';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

interface Capability extends Caplink.ProxyMarked {
  value: number;
  invoke(): string;
}

declare const capability: Capability;
declare const remoteCapability: Caplink.Remote<Capability>;

type SqlValue = string | number | null | bigint | Uint8Array | Int8Array | ArrayBuffer;
type JsonPatch = { __patch__: object | null };
declare const sqlValueOrPatch: SqlValue | JsonPatch;
declare const acceptSqlValueOrPatch: Caplink.Remote<(value: SqlValue | JsonPatch) => void>;
acceptSqlValueOrPatch(sqlValueOrPatch);
type SqlValueArgumentIsUnchanged = Expect<Equal<
  Parameters<typeof acceptSqlValueOrPatch>[0],
  SqlValue | JsonPatch
>>;

declare const optionalConfirmationHost: {
  confirmLargeChanges(): Promise<void>;
} | undefined;
const confirmationCapability = Caplink.proxy({
  async confirmLargeChanges() {
    await optionalConfirmationHost?.confirmLargeChanges();
  },
});
declare const acceptConfirmationCapability: Caplink.Remote<(
  remote?: { confirmLargeChanges(): Promise<void> },
) => void>;
acceptConfirmationCapability(confirmationCapability);

const record = Caplink.record({ capability, label: 'record' as const });
type RecordMarkerIsBoolean = Expect<Equal<typeof record[typeof Caplink.recordMarker], true>>;
declare const returnRecord: Caplink.Remote<() => typeof record>;
type ReturnedRecord = Awaited<ReturnType<typeof returnRecord>>;
type RecordReturnIsMapped = Expect<Equal<ReturnedRecord, {
  capability: Caplink.Remote<Capability>;
  label: 'record';
}>>;

const tuple = Caplink.tuple([capability, 42] as const);
type TupleMarkerIsBoolean = Expect<Equal<typeof tuple[typeof Caplink.tupleMarker], true>>;
declare const returnTuple: Caplink.Remote<() => typeof tuple>;
type ReturnedTuple = Awaited<ReturnType<typeof returnTuple>>;
type TupleReturnIsMapped = Expect<Equal<ReturnedTuple, readonly [
  Caplink.Remote<Capability>,
  42,
]>>;

declare const acceptRecord: Caplink.Remote<(value: typeof record) => boolean>;
acceptRecord(Caplink.record({ capability: remoteCapability, label: 'record' as const }));
acceptRecord(Caplink.record({ capability, label: 'record' as const }));

const nested = Caplink.record({ values: Caplink.tuple([capability] as const) });
declare const returnNested: Caplink.Remote<() => typeof nested>;
type ReturnedNested = Awaited<ReturnType<typeof returnNested>>;
type NestedReturnIsMapped = Expect<Equal<ReturnedNested, {
  values: readonly [Caplink.Remote<Capability>];
}>>;

const array = Caplink.tuple([capability] as Capability[]);
declare const returnArray: Caplink.Remote<() => typeof array>;
type ReturnedArray = Awaited<ReturnType<typeof returnArray>>;
type ArrayReturnIsMapped = Expect<Equal<ReturnedArray, Caplink.Remote<Capability>[]>>;

const optional = Caplink.record({ capability: undefined as Capability | undefined });
declare const returnOptional: Caplink.Remote<() => typeof optional>;
type ReturnedOptional = Awaited<ReturnType<typeof returnOptional>>;
type OptionalReturnIsMapped = Expect<Equal<ReturnedOptional, {
  capability: Caplink.Remote<Capability> | undefined;
}>>;

export type RecordTupleTypeChecks = [
  RecordReturnIsMapped,
  TupleReturnIsMapped,
  NestedReturnIsMapped,
  ArrayReturnIsMapped,
  OptionalReturnIsMapped,
  RecordMarkerIsBoolean,
  TupleMarkerIsBoolean,
  SqlValueArgumentIsUnchanged,
];
