import { migration001Init } from "./001_init.js";
import { migration002FtsIndex } from "./002_fts_index.js";
import { migration003Vectors } from "./003_vectors.js";
import { migration004DeadLetters } from "./004_dead_letters.js";
import { migration005PendingMessages } from "./005_pending_messages.js";
import { migration006ReliabilityAndSyncState } from "./006_reliability_and_sync_state.js";

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  migration001Init,
  migration002FtsIndex,
  migration003Vectors,
  migration004DeadLetters,
  migration005PendingMessages,
  migration006ReliabilityAndSyncState,
];
