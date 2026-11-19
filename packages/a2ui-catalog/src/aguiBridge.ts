import {
  EventType,
  PROTOCOL_VERSION,
  type CustomEvent,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type StateDeltaEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
} from '@ag-ui/core'
import type { A2UISurfaceEnvelope } from './builders.js'

export type GisAgUiEvent =
  | RunStartedEvent
  | StepStartedEvent
  | StateDeltaEvent
  | CustomEvent
  | StepFinishedEvent
  | RunFinishedEvent
  | RunErrorEvent

export class GisAgUiEmitter {
  constructor(
    private readonly threadId: string,
    private readonly runId: string,
  ) {}

  runStarted(): RunStartedEvent {
    return {
      type: EventType.RUN_STARTED,
      threadId: this.threadId,
      runId: this.runId,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: Date.now(),
    }
  }

  stepStarted(stepName: string): StepStartedEvent {
    return {
      type: EventType.STEP_STARTED,
      stepName,
      timestamp: Date.now(),
    }
  }

  stateDelta(path: string, value: unknown): StateDeltaEvent {
    return {
      type: EventType.STATE_DELTA,
      delta: [{ op: 'replace', path, value }],
      timestamp: Date.now(),
    }
  }

  a2uiSurface(surface: A2UISurfaceEnvelope): CustomEvent {
    return {
      type: EventType.CUSTOM,
      name: 'a2ui.frame',
      value: surface,
      timestamp: Date.now(),
    }
  }

  stepFinished(stepName: string): StepFinishedEvent {
    return {
      type: EventType.STEP_FINISHED,
      stepName,
      timestamp: Date.now(),
    }
  }

  runFinished(result?: unknown): RunFinishedEvent {
    return {
      type: EventType.RUN_FINISHED,
      threadId: this.threadId,
      runId: this.runId,
      result,
      timestamp: Date.now(),
    }
  }

  runError(message: string, code?: string): RunErrorEvent {
    return {
      type: EventType.RUN_ERROR,
      message,
      code,
      timestamp: Date.now(),
    }
  }
}
