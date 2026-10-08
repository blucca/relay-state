import { randomUUID } from 'node:crypto';

const steps = [
  {
    key: 'label_ready', title: 'Save the return label',
    instruction: 'Enter the reference on the return label you received.',
    completedTitle: 'Return label saved', status: 'Label needed',
    command: 'label DEMO-LABEL-2048',
  },
  {
    key: 'dropped_off', title: 'Hand over the parcel',
    instruction: 'Pack the lamp with its label, then save your drop-off receipt reference.',
    completedTitle: 'Parcel drop-off reported', status: 'Ready to hand over',
    command: 'dropoff DEMO-DROPOFF-2048',
  },
  {
    key: 'refund_received', title: 'Check for the refund',
    instruction: 'When the $48.00 refund appears in your account, save its reference.',
    completedTitle: 'Refund receipt reported', status: 'Refund pending',
    command: 'refund DEMO-REFUND-2048',
  },
];

export function initialState() {
  return {
    schemaVersion: 1, kind: 'return-desk', id: `return-${randomUUID()}`,
    revision: 0, createdAt: new Date().toISOString(),
    order: 'DEMO-2048', item: 'Adjustable desk lamp', merchant: 'Demo Goods',
    refundCents: 4800, currency: 'USD', reports: [],
  };
}

export function validateState(state) {
  const valid = state?.schemaVersion === 1 && state.kind === 'return-desk'
    && typeof state.id === 'string' && state.id.startsWith('return-')
    && Number.isSafeInteger(state.revision) && state.revision >= 0
    && Number.isFinite(Date.parse(state.createdAt))
    && state.order === 'DEMO-2048' && state.item === 'Adjustable desk lamp'
    && state.merchant === 'Demo Goods' && state.refundCents === 4800 && state.currency === 'USD'
    && Array.isArray(state.reports) && state.reports.length <= steps.length
    && state.revision === state.reports.length
    && state.reports.every((report, index) => report.step === steps[index].key
      && typeof report.reference === 'string' && report.reference.length >= 3 && report.reference.length <= 120
      && report.source === 'user_reported' && Number.isFinite(Date.parse(report.at)));
  if (!valid) throw new Error('Return Desk state validation failed. Use a valid saved return or select a fresh RETURN_DESK_STATE_FILE.');
  return true;
}

/** The public contract used by both MCP clients and the browser. */
export function projectState(state) {
  const next = steps[state.reports.length];
  return {
    id: state.id, revision: state.revision,
    order: state.order, item: state.item, merchant: state.merchant,
    refund: { cents: state.refundCents, currency: state.currency },
    status: next?.status ?? 'Return complete', complete: !next,
    progress: { completed: state.reports.length, total: steps.length },
    nextAction: next ? { step: next.key, title: next.title, instruction: next.instruction, command: `npm run demo -- ${next.command}` } : {
      step: null, title: 'Keep your receipt',
      instruction: 'Your reported label, drop-off and refund references are saved together.', command: 'npm run demo -- read',
    },
    timeline: steps.map((step, index) => ({
      step: step.key, title: step.completedTitle, current: index === state.reports.length,
      report: state.reports[index] ? { ...state.reports[index] } : null,
    })),
    provenance: 'Fictional order. All progress is reported by the person using this sample.',
  };
}

export const toolDefinitions = [
  {
    name: 'get_return',
    description: 'Resume the saved demo return, including reported references and the current next action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'record_return_step',
    description: 'Save a user-reported label, parcel drop-off, or refund receipt for the fictional return. Follow the nextAction from get_return. Each step accepts one reference.',
    inputSchema: {
      type: 'object', required: ['step', 'reference'], additionalProperties: false,
      properties: {
        step: { type: 'string', enum: steps.map(step => step.key) },
        reference: { type: 'string', minLength: 3, maxLength: 120, description: 'Reference reported by the user; use a DEMO reference for this sample.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Revision read from get_return. A stale write returns the current return for review.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** Workflow rules belong to this consumer. Relay State commits the returned state. */
export function recordStep(state, args) {
  const fail = (code, message) => ({
    state, commit: false,
    result: { ok: false, error: { code, message }, return: projectState(state) },
  });
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !['step', 'reference', 'expectedRevision'].includes(key))
    || !steps.some(step => step.key === args.step)
    || typeof args.reference !== 'string' || args.reference.trim().length < 3 || args.reference.trim().length > 120
    || (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0))) {
    return fail('INVALID_INPUT', 'Choose a listed step and a reference between 3 and 120 characters. expectedRevision accepts a nonnegative integer.');
  }
  const reference = args.reference.trim();
  const existing = state.reports.find(report => report.step === args.step);
  if (existing?.reference === reference) {
    return { state, commit: false, result: { ok: true, replayed: true, return: projectState(state) } };
  }
  if (args.expectedRevision !== undefined && args.expectedRevision !== state.revision) {
    return fail('REVISION_CONFLICT', `The saved return is at revision ${state.revision}. Review its next action and retry with that revision.`);
  }
  if (existing) return fail('STEP_RECORDED', 'This step already has a saved reference. The current return includes it.');
  const next = steps[state.reports.length];
  if (args.step !== next?.key) {
    return fail('NEXT_STEP_REQUIRED', `Complete the current next action: ${next?.title ?? 'Keep your receipt'}.`);
  }
  state.reports.push({ step: args.step, reference, source: 'user_reported', at: new Date().toISOString() });
  state.revision += 1;
  return { state, result: { ok: true, replayed: false, return: projectState(state) } };
}
