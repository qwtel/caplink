/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TypedEventTarget } from "@workers/typed-event-target";

export type MessageEventTarget = Pick<TypedEventTarget<MessagePortEventMap>, "addEventListener"|"removeEventListener">;

export const messageChannel = Symbol('Caplink.messageChannel');
export const adoptNative = Symbol('Caplink.adaptNative');
export const toNative = Symbol('Caplink.toNative');

export interface PostMessageWithOrigin {
  postMessage(
    message: any,
    targetOrigin: string,
    transfer?: Transferable[]
  ): void;
}

export interface Endpoint extends MessageEventTarget {
  postMessage(message: any, transfer?: Transferable[]|StructuredSerializeOptions): void;
  start?: () => void;
  [messageChannel]?: typeof MessageChannel;
  [adoptNative]?: (port: MessagePort) => MessagePort;
  [toNative]?: () => MessagePort;
}

export const enum WireValueType {
  RAW = "RAW",
  PROXY = "PROXY",
  THROW = "THROW",
  HANDLER = "HANDLER",
}


export type MessageId = string|number;

export interface RawWireValue {
  id?: MessageId;
  type: WireValueType.RAW;
  value: unknown;
}

export interface HandlerWireValue {
  id?: MessageId;
  type: WireValueType.HANDLER;
  name: string;
  value: unknown;
}

export type WireValue = RawWireValue | HandlerWireValue;

export const enum MessageType {
  GET = "GET",
  SET = "SET",
  APPLY = "APPLY",
  CONSTRUCT = "CONSTRUCT",
  ENDPOINT = "ENDPOINT",
  RELEASE = "RELEASE",
}

export interface GetMessage {
  id?: MessageId;
  type: MessageType.GET;
  path: string[];
}

export interface SetMessage {
  id?: MessageId;
  type: MessageType.SET;
  path: string[];
  value: WireValue;
}

export interface ApplyMessage {
  id?: MessageId;
  type: MessageType.APPLY;
  path: string[];
  argumentList: WireValue[];
}

export interface ConstructMessage {
  id?: MessageId;
  type: MessageType.CONSTRUCT;
  path: string[];
  argumentList: WireValue[];
}

export interface EndpointMessage {
  id?: MessageId;
  type: MessageType.ENDPOINT;
  value: MessagePort;
}

export interface ReleaseMessage {
  id?: MessageId;
  type: MessageType.RELEASE;
}

export type Message =
  | GetMessage
  | SetMessage
  | ApplyMessage
  | ConstructMessage
  | EndpointMessage
  | ReleaseMessage;
