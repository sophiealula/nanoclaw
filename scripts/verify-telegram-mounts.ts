// Verify telegram_main mounts are valid via NanoClaw's own validator.
// Runs validateAdditionalMounts() exactly as the container runner does.
import Database from 'better-sqlite3';
import { validateAdditionalMounts } from '../src/mount-security.js';
import type { AdditionalMount } from '../src/types.js';

const db = new Database('/Users/sophiedavis/projects/nanoclaw/store/messages.db', { readonly: true });
const row = db.prepare("SELECT container_config FROM registered_groups WHERE folder = 'telegram_main'").get() as { container_config: string | null } | undefined;

if (!row || !row.container_config) {
  console.error('FAIL: telegram_main has no container_config');
  process.exit(1);
}

const config = JSON.parse(row.container_config);
const mounts: AdditionalMount[] = config.additionalMounts || [];

console.log(`Validating ${mounts.length} requested mounts for telegram_main (isMain=true):\n`);
for (const m of mounts) {
  console.log(`  - ${m.hostPath} → ${m.containerPath || '(basename)'} (readonly=${m.readonly ?? true})`);
}

const validated = validateAdditionalMounts(mounts, 'Soph', true);
console.log(`\n=== Validator accepted ${validated.length} / ${mounts.length} ===\n`);
for (const m of validated) {
  console.log(`  ✓ ${m.hostPath} → ${m.containerPath} (readonly=${m.readonly})`);
}

if (validated.length < mounts.length) {
  console.error(`\nFAIL: ${mounts.length - validated.length} mounts rejected.`);
  process.exit(1);
}
console.log('\nPASS: all mounts validated.');
