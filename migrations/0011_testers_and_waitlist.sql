-- Beta testers get Pro features free (role 'tester'); members can join the Pro launch list.
ALTER TABLE users ADD COLUMN pro_waitlist INTEGER NOT NULL DEFAULT 0;
