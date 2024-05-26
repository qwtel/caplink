/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TypedEventTarget } from "@worker-tools/typed-event-target";

export type ReceiverEndpoint = Pick<TypedEventTarget<MessagePortEventMap>, "addEventListener"|"removeEventListener">;

export interface PostMessageWithOrigin {
  postMessage(
    message: any,
    targetOrigin: string,
    transfer?: Transferable[]
  ): void;
}

export interface Endpoint extends ReceiverEndpoint {
  postMessage(message: any, transfer?: Transferable[]): void;
  start?: () => void;
}

export const enum WireValueType {
  RAW = "RAW",
  PROXY = "PROXY",
  THROW = "THROW",
  HANDLER = "HANDLER",
}

export interface RawWireValue {
  id?: string|number;
  type: WireValueType.RAW;
  value: {};
}

export interface HandlerWireValue {
  id?: string|number;
  type: WireValueType.HANDLER;
  name: string;
  value: unknown;
}

export type WireValue = RawWireValue | HandlerWireValue;

export type MessageId = string|number;

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
}

export interface ReleaseMessage {
  id?: MessageId;
  type: MessageType.RELEASE;
}

export const enum IterType {
  NEXT = "NEXT",
  RETURN = "RETURN",
  THROW = "THROW",
}

export type IterMessage = {
  id?: MessageId
  type: IterType
  value: WireValue
}

export type Message =
  | GetMessage
  | SetMessage
  | ApplyMessage
  | ConstructMessage
  | EndpointMessage
  | ReleaseMessage;
