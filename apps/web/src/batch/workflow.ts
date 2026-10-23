// One batch, start to finish (T16).
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

interface BatchParams {
  batchId: string;
}

export class BatchWorkflow extends WorkflowEntrypoint<Env, BatchParams> {
  override async run(
    _event: WorkflowEvent<BatchParams>,
    _step: WorkflowStep,
  ): Promise<void> {}
}
