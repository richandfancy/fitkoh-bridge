-- BAC-1216: Add scopes to API keys.
--
-- Default preserves today's behavior for existing keys: they keep full access
-- to all meal reads + writes. New keys can be minted with narrower scopes.
--
-- Scope format: "{resource}:{action}[:{target}]"
--   meals:read:all   — read any guest's meals (admin / FitKoh backend)
--   meals:read:self  — read only the caller's own meals (paired with a JWT)
--   meals:write      — log or mutate meal data

ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["meals:read:all","meals:write"]';
