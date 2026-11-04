-- When an edit added each branch to a checklist (SCRUM-749): branch id to the
-- time it was added. The recurring run creator starts a branch's runs no earlier
-- than that day, so a branch shared onto an older checklist is not given every
-- run since the checklist was made. Existing checklists start with no entries:
-- a branch with none has been on its checklist since the checklist was made.
ALTER TABLE "checklist_templates" ADD COLUMN "branch_added_at" jsonb DEFAULT '{}'::jsonb NOT NULL;