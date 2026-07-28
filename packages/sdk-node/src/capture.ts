import type { InspectorClient } from "./inspector-client.js";
import {
  CAPTURE_TRUNCATED_VALUE,
  isCaptureTruncated,
  type CaptureTruncated,
} from "./capture-marker.js";
import type {
  CallFrameDescriptor,
  PausedEvent,
  PropertyDescriptor,
  RemoteObject,
  StackFrame,
} from "./types.js";

export interface RawCapture {
  variables: Record<string, unknown>;
  frameLocals: Array<Record<string, unknown> | CaptureTruncated>;
  stack: StackFrame[];
}

interface CaptureOptions {
  maxArray: number;
  maxDepth: number;
  maxObjects: number;
  maxProps: number;
  maxStackFrames: number;
  redactKeys: readonly string[];
  scriptPath(scriptId: string): string;
}

interface CaptureTask {
  depth: number;
  objectId: string;
  target: Record<string, unknown> | unknown[];
  /**
   * Set on the outer scopes of a frame so an inner binding that shadows an
   * outer one of the same name wins.
   */
  preserveExisting?: boolean;
}

const CAPTURED_FUNCTION = (): void => {};

function defineData(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isRedactedKey(key: string, patterns: readonly string[]): boolean {
  const normalized = key.toLocaleLowerCase("en-US");
  return patterns.some((pattern) => normalized.includes(pattern));
}

function remotePrimitive(remote: RemoteObject): unknown {
  if (remote.type === "function") return CAPTURED_FUNCTION;
  if (remote.subtype === "null") return null;
  if (remote.type === "undefined" || remote.type === "symbol" || remote.type === "bigint") {
    return undefined;
  }
  if (remote.unserializableValue !== undefined) {
    return undefined;
  }
  return remote.value;
}

function createContainer(remote: RemoteObject): Record<string, unknown> | unknown[] {
  return remote.subtype === "array" ? [] : Object.create(null) as Record<string, unknown>;
}

/**
 * Scope kinds that hold bindings a probe author would call "local". `block`
 * carries the per-iteration binding of `for (let i …)`, which V8 keeps out of
 * the `local` scope. `closure` and `global` are deliberately excluded: merging
 * them would leak module-level state into `variables`.
 */
const FRAME_SCOPE_TYPES = new Set(["local", "block", "catch"]);

/**
 * Frame scope object ids, innermost first — V8 orders `scopeChain` that way.
 */
function frameScopeIds(frame: CallFrameDescriptor): string[] {
  const ids: string[] = [];
  for (const scope of frame.scopeChain) {
    const objectId = scope.object.objectId;
    if (FRAME_SCOPE_TYPES.has(scope.type) && objectId !== undefined && !ids.includes(objectId)) {
      ids.push(objectId);
    }
  }
  return ids;
}

function selectedDescriptors(
  descriptors: readonly PropertyDescriptor[],
  target: Record<string, unknown> | unknown[],
  options: CaptureOptions,
): PropertyDescriptor[] {
  const enumerable = descriptors.filter((descriptor) => descriptor.enumerable !== false);
  if (!Array.isArray(target)) {
    return enumerable.slice(0, options.maxProps + 1);
  }

  const lengthDescriptor = descriptors.find((descriptor) => descriptor.name === "length");
  const length = lengthDescriptor?.value?.value;
  if (typeof length === "number" && Number.isSafeInteger(length) && length >= 0) {
    target.length = length;
  }
  return enumerable
    .filter((descriptor) => /^(0|[1-9]\d*)$/u.test(descriptor.name))
    .sort((left, right) => Number(left.name) - Number(right.name))
    .filter((descriptor) => Number(descriptor.name) < options.maxArray);
}

/**
 * Captures through protocol callbacks only. The caller owns resumption and must
 * not perform any asynchronous application work until this callback completes.
 */
export function capturePaused(
  inspector: Pick<InspectorClient, "getProperties">,
  paused: PausedEvent,
  options: CaptureOptions,
  callback: (error: Error | null, capture: RawCapture) => void,
): void {
  const frames = paused.callFrames.slice(0, options.maxStackFrames);
  const frameLocals: RawCapture["frameLocals"] = frames.map(
    () => Object.create(null) as Record<string, unknown>,
  );
  const stack = frames.map((frame): StackFrame => ({
    fn: frame.functionName || "(anonymous)",
    file: options.scriptPath(frame.location.scriptId),
    line: frame.location.lineNumber + 1,
  }));
  const tasks: CaptureTask[] = [];
  const materializedObjects = new Map<string, Record<string, unknown> | unknown[]>();
  const objectBudget = Math.max(1, options.maxObjects);

  frames.forEach((frame, index) => {
    const scopeIds = frameScopeIds(frame);
    const target = frameLocals[index];
    if (scopeIds.length === 0 || target === undefined || isCaptureTruncated(target)) {
      return;
    }
    let captured = 0;
    for (const objectId of scopeIds) {
      if (tasks.length >= objectBudget) break;
      materializedObjects.set(objectId, target);
      // Scopes arrive innermost-first, so every scope after the first is an
      // enclosing one and must not overwrite a name it shadows.
      tasks.push({ depth: 0, objectId, target, preserveExisting: captured > 0 });
      captured += 1;
    }
    if (captured === 0) {
      frameLocals[index] = CAPTURE_TRUNCATED_VALUE;
    }
  });

  let firstError: Error | null = null;
  let visitedObjects = 0;
  let pumping = false;
  let pumpAgain = false;

  const finish = (): void => {
    callback(firstError, {
      variables:
        frameLocals[0] === undefined || isCaptureTruncated(frameLocals[0])
          ? (Object.create(null) as Record<string, unknown>)
          : frameLocals[0],
      frameLocals,
      stack,
    });
  };

  const step = (): void => {
    const task = tasks.shift();
    if (task === undefined) {
      finish();
      return;
    }
    visitedObjects += 1;

    inspector.getProperties({ objectId: task.objectId }, (error, result) => {
      if (error !== null || result === undefined) {
        firstError ??= error ?? new Error("inspector returned no properties");
        processNext();
        return;
      }

      for (const descriptor of selectedDescriptors(result.result, task.target, options)) {
        const key = descriptor.name;
        if (
          task.preserveExisting === true &&
          Object.prototype.hasOwnProperty.call(task.target, key)
        ) {
          continue;
        }
        if (isRedactedKey(key, options.redactKeys)) {
          if (!Array.isArray(task.target)) {
            defineData(task.target, key, undefined);
          }
          continue;
        }

        const remote = descriptor.value;
        const existing =
          remote?.objectId === undefined ? undefined : materializedObjects.get(remote.objectId);
        const needsTraversal =
          remote?.objectId !== undefined &&
          existing === undefined &&
          task.depth < options.maxDepth;
        const budgetExhausted =
          needsTraversal && visitedObjects + tasks.length >= objectBudget;
        const value =
          remote === undefined
            ? "[getter]"
            : remote.objectId === undefined
              ? remotePrimitive(remote)
              : existing ??
                (budgetExhausted ? CAPTURE_TRUNCATED_VALUE : createContainer(remote));

        if (Array.isArray(task.target)) {
          task.target[Number(key)] = value;
        } else {
          defineData(task.target, key, value);
        }

        if (
          remote?.objectId !== undefined &&
          existing === undefined &&
          !budgetExhausted &&
          typeof value === "object" &&
          value !== null &&
          task.depth < options.maxDepth &&
          visitedObjects + tasks.length < objectBudget
        ) {
          materializedObjects.set(remote.objectId, value as Record<string, unknown> | unknown[]);
          tasks.push({
            depth: task.depth + 1,
            objectId: remote.objectId,
            target: value as Record<string, unknown> | unknown[],
          });
        }
      }
      processNext();
    });
  };

  /**
   * Drives the task queue without nesting a frame per captured object.
   *
   * On a same-thread session `getProperties` calls back synchronously — that is
   * what lets a capture finish before the resume — so driving the queue by
   * having each callback call the next step would stack one nesting level per
   * object, up to `maxObjects`. That runs on top of the paused application's own
   * stack, and while the object count is bounded the headroom left at the pause
   * point is not: a probe on a deep call site overflowed with
   * `Maximum call stack size exceeded` while the same probe a line later, after
   * an `await` had unwound the stack, captured fine.
   *
   * A synchronous callback re-enters here, flags the pump and returns, so the
   * loop below picks the next task up at a constant depth. An asynchronous one
   * finds the pump idle and starts a fresh run.
   */
  const processNext = (): void => {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        step();
      } while (pumpAgain);
    } finally {
      pumping = false;
    }
  };

  processNext();
}
