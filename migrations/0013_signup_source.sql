-- Where a new account came from (utm_source / ref on the link they first landed on), for marketing.
ALTER TABLE users ADD COLUMN signup_source TEXT;
