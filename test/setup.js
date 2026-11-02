// Deterministic config for tests (must be imported before src/config.js).
process.env.POCKET_ENV_FILE = '/nonexistent';
process.env.OWNER_NUMBERS = '919811111111';
process.env.ALLOWED_NUMBERS = '919822222222';
process.env.DM_POLICY = 'allowlist';
process.env.BOT_NAME = 'Pocket';
process.env.GROUP_TRIGGERS = '/ai,hey {name}';
process.env.LOG_LEVEL = 'silent';
