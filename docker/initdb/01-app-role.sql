-- Local only: login role the API uses at runtime (not owner, no BYPASSRLS).
CREATE ROLE touchline_app LOGIN PASSWORD 'touchline_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
