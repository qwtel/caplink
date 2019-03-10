/**
 * Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export interface Endpoint {
  postMessage(message: any, transfer?: any[]): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: {}
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: {}
  ): void;
}

export const enum WireValueType {
  RAW,
  PROXY,
  THROW
}

export interface RawWireValue {
  id?: string;
  type: WireValueType.RAW;
  value: {};
}

export interface ProxyWireValue {
  id?: string;
  type: WireValueType.PROXY;
  endpoint: Endpoint;
}

export interface ThrowWireValue {
  id?: string;
  type: WireValueType.THROW;
  isError: boolean;
  value: {};
}

export type WireValue = RawWireValue | ProxyWireValue | ThrowWireValue;

export type MessageID = string;

export const enum MessageType {
  GET,
  SET,
  APPLY,
  CONSTRUCT
}

export interface GetMessage {
  id?: MessageID;
  type: MessageType.GET;
  path: string[];
}

export interface SetMessage {
  id?: MessageID;
  type: MessageType.SET;
  path: string[];
  value: WireValue;
}

export interface ApplyMessage {
  id?: MessageID;
  type: MessageType.APPLY;
  path: string[];
  argumentList: WireValue[];
}

export interface ConstructMessage {
  id?: MessageID;
  type: MessageType.CONSTRUCT;
  path: string[];
  argumentList: WireValue[];
}

export type Message = GetMessage | SetMessage | ApplyMessage | ConstructMessage;