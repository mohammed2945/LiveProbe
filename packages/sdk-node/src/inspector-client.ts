import { Session } from "node:inspector";

import type {
  GetPropertiesResult,
  PausedEvent,
  ScriptParsedEvent,
  SetBreakpointResult,
} from "./types.js";

type CommandCallback<T> = (error: Error | null, result?: T) => void;

interface InspectorSessionPort {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    params: Record<string, unknown>,
    callback: (error: Error | null, result?: unknown) => void,
  ): void;
  on(event: string, listener: (message: { params: unknown }) => void): this;
  removeListener(event: string, listener: (message: { params: unknown }) => void): this;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The sole protocol boundary. Its command surface is deliberately closed:
 * callers cannot submit arbitrary protocol method names.
 */
export class InspectorClient {
  readonly #session: InspectorSessionPort;
  #connected = false;

  constructor(session: InspectorSessionPort = new Session() as unknown as InspectorSessionPort) {
    this.#session = session;
  }

  connect(): void {
    if (this.#connected) return;
    this.#session.connect();
    this.#connected = true;
  }

  disconnect(): void {
    if (!this.#connected) return;
    this.#session.disconnect();
    this.#connected = false;
  }

  onScriptParsed(listener: (event: ScriptParsedEvent) => void): () => void {
    const wrapped = (message: { params: unknown }): void => {
      listener(message.params as ScriptParsedEvent);
    };
    this.#session.on("Debugger.scriptParsed", wrapped);
    return () => this.#session.removeListener("Debugger.scriptParsed", wrapped);
  }

  onPaused(listener: (event: PausedEvent) => void): () => void {
    const wrapped = (message: { params: unknown }): void => {
      listener(message.params as PausedEvent);
    };
    this.#session.on("Debugger.paused", wrapped);
    return () => this.#session.removeListener("Debugger.paused", wrapped);
  }

  enable(callback: CommandCallback<Record<string, never>>): void {
    this.#send("Debugger.enable", {}, callback);
  }

  setBreakpointByUrl(
    params: { lineNumber: number; columnNumber?: number; url: string },
    callback: CommandCallback<SetBreakpointResult>,
  ): void {
    this.#send("Debugger.setBreakpointByUrl", params, callback);
  }

  removeBreakpoint(
    params: { breakpointId: string },
    callback: CommandCallback<Record<string, never>>,
  ): void {
    this.#send("Debugger.removeBreakpoint", params, callback);
  }

  resume(callback: CommandCallback<Record<string, never>>): void {
    this.#send("Debugger.resume", {}, callback);
  }

  getProperties(
    params: { objectId: string },
    callback: CommandCallback<GetPropertiesResult>,
  ): void {
    this.#send(
      "Runtime.getProperties",
      {
        accessorPropertiesOnly: false,
        generatePreview: false,
        objectId: params.objectId,
        ownProperties: true,
      },
      callback,
    );
  }

  #send<T>(
    method: string,
    params: Record<string, unknown>,
    callback: CommandCallback<T>,
  ): void {
    try {
      this.#session.post(method, params, (error, result) => {
        if (error !== null) {
          callback(asError(error));
          return;
        }
        callback(null, result as T);
      });
    } catch (error) {
      callback(asError(error));
    }
  }
}
