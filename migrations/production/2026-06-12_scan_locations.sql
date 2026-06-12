-- Capture scan city + region so the campaign analytics can show
-- "Top locations" alongside the existing country column.
-- Purely additive: existing rows keep country only; new scans populate all three.
alter table mailing_scans add column if not exists city   text;
alter table mailing_scans add column if not exists region text;
