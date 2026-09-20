/**
 * The v1 seed template chain (migration 20260911000002 — one six-step chain,
 * identical across every skill seed; Story 7-2/migration 20260913000004 later
 * added requires_location: true to every step), shared by the e2e/integration
 * specs so a chain change lands in one place. Used wherever a mock job row
 * must carry the workflow_templates FK embed the forward-advance path parses.
 *
 * The src/ unit specs keep their own inline copies — jest's src rootDir
 * boundary keeps test/ imports out of reach there (accepted in Story 4.5).
 */

export const V1_TEMPLATE_STEPS: unknown[] = [
  {
    key: 'on_my_way',
    label: 'On My Way',
    requires_photo: false,
    requires_signature: false,
    requires_location: true,
    sets_status: 'in_progress',
    advances_on: null,
  },
  {
    key: 'arrived',
    label: 'Arrived',
    requires_photo: false,
    requires_signature: false,
    requires_location: true,
    sets_status: null,
    advances_on: null,
  },
  {
    key: 'in_progress',
    label: 'In Progress',
    requires_photo: false,
    requires_signature: false,
    requires_location: true,
    sets_status: null,
    advances_on: null,
  },
  {
    key: 'photos_uploaded',
    label: 'Photos Uploaded',
    requires_photo: true,
    requires_signature: false,
    requires_location: true,
    sets_status: null,
    advances_on: 'photo_confirm',
  },
  {
    key: 'signature_captured',
    label: 'Signature Captured',
    requires_photo: false,
    requires_signature: true,
    requires_location: true,
    sets_status: null,
    advances_on: null,
  },
  {
    key: 'completed',
    label: 'Completed',
    requires_photo: false,
    requires_signature: false,
    requires_location: true,
    sets_status: 'completed',
    advances_on: null,
  },
];

/** The full workflow_templates FK embed value for a v1-stamped job row. */
export const V1_TEMPLATE = { version: 1, steps: V1_TEMPLATE_STEPS };
