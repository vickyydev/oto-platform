-- Add Thai name field to employees table
ALTER TABLE employees ADD COLUMN IF NOT EXISTS thai_name TEXT;

-- Add comment for documentation
COMMENT ON COLUMN employees.thai_name IS 'Thai language name (optional)';
