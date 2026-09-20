ALTER TABLE "checklist_template_items"
  ADD COLUMN IF NOT EXISTS "camera_enabled" boolean DEFAULT true NOT NULL,
  ADD COLUMN IF NOT EXISTS "gallery_enabled" boolean DEFAULT false NOT NULL;

-- Convert the retired checklist-wide requirement into item-level settings.
UPDATE "checklist_template_items" AS "item"
SET "requires_photo" = true
FROM "checklist_templates" AS "template"
WHERE "item"."template_id" = "template"."id"
  AND "template"."requires_photo_evidence" = true;

-- Preserve gallery-only items; otherwise ensure every required item retains a
-- usable camera evidence method.
UPDATE "checklist_template_items"
SET "camera_enabled" = true
WHERE "requires_photo" = true
  AND "camera_enabled" = false
  AND "gallery_enabled" = false;

UPDATE "checklist_templates"
SET "requires_photo_evidence" = false
WHERE "requires_photo_evidence" = true;
