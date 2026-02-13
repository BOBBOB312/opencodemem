export const migration002FtsIndex = {
  name: "002_fts_index",
  sql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_index USING fts5(
      observation_id UNINDEXED,
      title,
      text,
      tags,
      files
    );

    INSERT INTO memory_index(observation_id, title, text, tags, files)
    SELECT
      o.id,
      o.title,
      COALESCE(o.text, ''),
      COALESCE(o.type, ''),
      COALESCE(o.files_read, '')
    FROM observations o
    WHERE NOT EXISTS (
      SELECT 1 FROM memory_index mi WHERE mi.observation_id = o.id
    );

    CREATE TRIGGER IF NOT EXISTS trg_observations_ai_fts
    AFTER INSERT ON observations
    BEGIN
      INSERT INTO memory_index(observation_id, title, text, tags, files)
      VALUES (
        new.id,
        new.title,
        COALESCE(new.text, ''),
        COALESCE(new.type, ''),
        COALESCE(new.files_read, '')
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_observations_au_fts
    AFTER UPDATE ON observations
    BEGIN
      DELETE FROM memory_index WHERE observation_id = old.id;
      INSERT INTO memory_index(observation_id, title, text, tags, files)
      VALUES (
        new.id,
        new.title,
        COALESCE(new.text, ''),
        COALESCE(new.type, ''),
        COALESCE(new.files_read, '')
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_observations_ad_fts
    AFTER DELETE ON observations
    BEGIN
      DELETE FROM memory_index WHERE observation_id = old.id;
    END;
  `,
} as const;
