-- Add requires_location: true to all existing workflow steps
UPDATE workflow_templates
SET steps = (
  SELECT jsonb_agg(
    CASE
      WHEN step ? 'requires_location' THEN step
      ELSE step || jsonb_build_object('requires_location', true)
    END
  )
  FROM jsonb_array_elements(workflow_templates.steps) AS step
)
WHERE steps IS NOT NULL;
