-- The product is spelled Coldlyne now: its restricted role too. Policies, grants and the
-- membership granted to the owner follow the role, not its name.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'coldline_app') AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'coldlyne_app') THEN
    ALTER ROLE coldline_app RENAME TO coldlyne_app;
  END IF;
END $$;
