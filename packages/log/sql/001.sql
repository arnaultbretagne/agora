-- Run as the migration owner. Runtime connections use separate non-owner logins.
DO $$ BEGIN CREATE ROLE agora_writer NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE agora_projector NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE agora_anchors NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS workstreams (
 id uuid PRIMARY KEY, owner uuid NOT NULL, last_position bigint NOT NULL DEFAULT 0 CHECK(last_position >= 0)
);
-- A sub-stream's line (docs/specs/log.md, "Sub-streams"): its parent, its root — none for a root, which is its
-- own — and its depth. Added so that a server of the schema before keeps writing roots as it did.
ALTER TABLE workstreams ADD COLUMN IF NOT EXISTS parent uuid REFERENCES workstreams(id);
ALTER TABLE workstreams ADD COLUMN IF NOT EXISTS root uuid REFERENCES workstreams(id);
ALTER TABLE workstreams ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0 CHECK(depth >= 0);
-- The projector's own row: its lock never waits on capture, which locks the Workstream row.
CREATE TABLE IF NOT EXISTS threads (
 workstream uuid PRIMARY KEY REFERENCES workstreams(id), last_position bigint NOT NULL DEFAULT 0 CHECK(last_position >= 0)
);
CREATE TABLE IF NOT EXISTS entries (
 workstream uuid NOT NULL REFERENCES workstreams(id), position bigint NOT NULL CHECK(position > 0),
 kind text NOT NULL CHECK(kind IN ('command','acp','acp.dispatching','acp.sent','request.failed','execution.obtained','execution.failed','anchor.received','session.opened','session.ended','execution.connected','execution.break','execution.lost','execution.ended')),
 execution uuid, session uuid, content jsonb NOT NULL, time timestamptz NOT NULL DEFAULT now(),
 direction text CHECK(direction IN ('in','out')), rpc_kind text CHECK(rpc_kind IN ('request','response','error','notification')),
 method text, correlated_method text, request_position bigint, rpc_id jsonb, command uuid, connection uuid, receive_ordinal bigint,
 PRIMARY KEY(workstream,position), UNIQUE(connection,receive_ordinal),
 CHECK((connection IS NULL) = (receive_ordinal IS NULL) OR receive_ordinal IS NULL)
);
CREATE INDEX IF NOT EXISTS entries_execution ON entries(execution,position);
CREATE TABLE IF NOT EXISTS commands (
 workstream uuid NOT NULL REFERENCES workstreams(id), id uuid NOT NULL, kind text NOT NULL, target jsonb NOT NULL,
 fingerprint text NOT NULL, answer jsonb NOT NULL, position bigint NOT NULL, execution uuid, claim_name text,
 PRIMARY KEY(workstream,id), UNIQUE(execution), UNIQUE(claim_name)
);
CREATE TABLE IF NOT EXISTS sessions (
 id uuid PRIMARY KEY, workstream uuid NOT NULL REFERENCES workstreams(id), execution uuid NOT NULL, acp_id text NOT NULL,
 opened_position bigint NOT NULL, ended_position bigint
);
CREATE TABLE IF NOT EXISTS diagnostics (
 id uuid PRIMARY KEY, workstream uuid NOT NULL REFERENCES workstreams(id), execution uuid NOT NULL, connection uuid NOT NULL,
 receive_ordinal bigint, direction text NOT NULL CHECK(direction IN ('in','out')), reason text NOT NULL CHECK(reason IN ('invalid_utf8','invalid_json','invalid_envelope','batch','wrong_direction','invalid_body','unsafe_id','line_too_large','unsupported_json_value','transport_error','response_timeout','deadline_refused','startup_failed','restore_failed','claim_conflict','claim_missing','adapter_exited','instance_changed','deadline_reached','stopped','replaced','anchor_missing')),
 size bigint NOT NULL, sha256 text NOT NULL, time timestamptz NOT NULL DEFAULT now(), UNIQUE(connection,receive_ordinal)
);
CREATE TABLE IF NOT EXISTS anchors (
 id uuid PRIMARY KEY, workstream uuid NOT NULL REFERENCES workstreams(id), execution uuid NOT NULL, session uuid,
 metadata jsonb NOT NULL, content bytea NOT NULL, time timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS objects (
 workstream uuid NOT NULL REFERENCES workstreams(id), projector text NOT NULL, kind text NOT NULL CHECK(kind IN ('workstream','turn','element','notice')),
 id uuid NOT NULL, object jsonb NOT NULL, first_position bigint NOT NULL, last_position bigint NOT NULL,
 PRIMARY KEY(workstream,kind,id)
);
-- An element's type in a column of its own (docs/specs/search.md): what a search filters on without reading
-- the object. Filled once for the elements projected before it.
ALTER TABLE objects ADD COLUMN IF NOT EXISTS type text;
UPDATE objects SET type = object->>'type' WHERE kind = 'element' AND type IS NULL AND object ? 'type';
CREATE INDEX IF NOT EXISTS objects_type ON objects(type, workstream) WHERE kind = 'element';
CREATE TABLE IF NOT EXISTS thread (
 workstream uuid NOT NULL REFERENCES workstreams(id), position bigint NOT NULL,
 operation text NOT NULL CHECK(operation IN ('upsert','remove','reset')), kind text, id uuid, object jsonb,
 PRIMARY KEY(workstream,position)
);
CREATE TABLE IF NOT EXISTS checkpoints (
 workstream uuid NOT NULL REFERENCES workstreams(id), projector text NOT NULL, version text NOT NULL,
 position bigint NOT NULL, PRIMARY KEY(workstream,projector)
);
-- An owner's list (docs/specs/log.md, "The list"): its row is the lock that orders the owner's rows.
CREATE TABLE IF NOT EXISTS lists (
 owner uuid PRIMARY KEY, last_position bigint NOT NULL DEFAULT 0 CHECK(last_position >= 0)
);
CREATE TABLE IF NOT EXISTS listings (
 workstream uuid PRIMARY KEY REFERENCES workstreams(id), owner uuid NOT NULL, position bigint NOT NULL CHECK(position > 0),
 changed_at timestamptz NOT NULL, title text NOT NULL, row jsonb NOT NULL, UNIQUE(owner,position)
);
CREATE INDEX IF NOT EXISTS listings_recent ON listings(owner,changed_at DESC,workstream DESC);
-- An element's text in a transcript (docs/specs/search.md, "The transcript"): what the catch-up gives of it
-- (docs/specs/log.md, "Continuing", "An exchange").
CREATE OR REPLACE FUNCTION transcript_text(element_type text, element jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE element_type
    WHEN 'agent_message_chunk' THEN btrim(coalesce(element->>'text', ''), E' \t\r\n')
    WHEN 'tool' THEN '[tool: ' || coalesce(nullif(element->>'title', ''), 'unnamed') || CASE WHEN element->>'status' = 'failed' THEN ' — failed' ELSE '' END || ']'
    WHEN 'user' THEN (
      SELECT string_agg(part, E'\n' ORDER BY i) FROM (
        SELECT i, CASE b->>'type'
          WHEN 'text' THEN coalesce(b->>'text', '')
          WHEN 'resource_link' THEN '[link: ' || coalesce(b->>'name', b->>'uri', '') || ']'
          WHEN 'resource' THEN '[resource: ' || coalesce(b->'resource'->>'uri', '') || ']'
          ELSE '[' || coalesce(b->>'type', 'content') || ']' END AS part
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(element->'content') = 'array' THEN element->'content' ELSE '[]'::jsonb END) WITH ORDINALITY AS x(b, i)
      ) parts WHERE part <> '')
  END
$$;
-- Workstreams' transcripts (docs/specs/search.md, "The transcript"): each exchange as numbered lines, in the
-- order of its turn's prompt — its header and the user's text, then the agent's header, its text and its tools,
-- in the order of their first positions. Elements outside any turn are left out.
CREATE OR REPLACE FUNCTION transcript(of_workstreams uuid[])
  RETURNS TABLE(workstream uuid, line bigint, exchange bigint, kind text, text text) LANGUAGE sql STABLE AS $$
  WITH turns AS (
    SELECT o.workstream, o.id AS turn, o.object->>'startedAt' AS started,
      row_number() OVER (PARTITION BY o.workstream ORDER BY (o.object->>'requestPosition')::bigint, o.id) AS exchange
    FROM objects o WHERE o.workstream = ANY(of_workstreams) AND o.kind = 'turn'
  ), parts AS (
    SELECT t.workstream, t.exchange, 0 AS slot, 0::bigint AS place, 'header' AS kind,
      '## ' || t.exchange || coalesce(' · ' || to_char(t.started::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'), '') || ' · you' AS text
    FROM turns t
    UNION ALL
    SELECT t.workstream, t.exchange, 2, 0, 'header', '## ' || t.exchange || ' · agent' FROM turns t
    UNION ALL
    SELECT t.workstream, t.exchange, CASE e.type WHEN 'user' THEN 1 ELSE 3 END, e.first_position,
      CASE e.type WHEN 'user' THEN 'user' WHEN 'tool' THEN 'tool' ELSE 'agent' END, transcript_text(e.type, e.object)
    FROM objects e JOIN turns t ON t.workstream = e.workstream AND t.turn::text = e.object->>'turn'
    WHERE e.workstream = ANY(of_workstreams) AND e.kind = 'element' AND e.type IN ('user', 'agent_message_chunk', 'tool')
  )
  SELECT p.workstream, row_number() OVER (PARTITION BY p.workstream ORDER BY p.exchange, p.slot, p.place, l.ord), p.exchange, p.kind, l.text
  FROM parts p CROSS JOIN LATERAL regexp_split_to_table(p.text, E'\n') WITH ORDINALITY AS l(text, ord)
  WHERE p.text IS NOT NULL AND p.text <> ''
$$;
REVOKE ALL ON workstreams,threads,entries,commands,sessions,diagnostics,anchors,objects,thread,checkpoints,lists,listings FROM PUBLIC;
REVOKE ALL ON workstreams,threads,entries,commands,sessions,diagnostics,anchors,objects,thread,checkpoints,lists,listings FROM agora_writer,agora_projector,agora_anchors;
REVOKE SELECT(content) ON anchors FROM agora_writer,agora_projector;
-- Only the log's roles connect, besides the owner applying this file.
DO $$ BEGIN
 EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO agora_writer, agora_projector, agora_anchors', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO agora_writer,agora_projector,agora_anchors;
GRANT SELECT(id,owner,last_position,parent,root,depth), INSERT(id,owner,parent,root,depth), UPDATE(last_position) ON workstreams TO agora_writer;
GRANT SELECT(workstream,position,kind,execution,session,content,time,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal),
 INSERT(workstream,position,kind,execution,session,content,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal) ON entries TO agora_writer;
GRANT SELECT(workstream,id,kind,target,fingerprint,answer,position,execution,claim_name), INSERT(workstream,id,kind,target,fingerprint,answer,position,execution,claim_name) ON commands TO agora_writer;
GRANT SELECT(id,workstream,execution,acp_id,opened_position,ended_position), INSERT(id,workstream,execution,acp_id,opened_position) ON sessions TO agora_writer;
GRANT SELECT(id,workstream,execution,connection,receive_ordinal,direction,reason,size,sha256,time), INSERT(id,workstream,execution,connection,receive_ordinal,direction,reason,size,sha256) ON diagnostics TO agora_writer;
GRANT UPDATE(ended_position) ON sessions TO agora_writer;
GRANT SELECT(id,workstream,execution,session,metadata,time) ON anchors TO agora_writer;
GRANT SELECT(id,owner,parent,root,depth) ON workstreams TO agora_projector;
GRANT SELECT(workstream,last_position), INSERT(workstream), UPDATE(last_position) ON threads TO agora_projector;
GRANT SELECT(workstream,position,kind,execution,session,content,time,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal) ON entries TO agora_projector;
GRANT SELECT(workstream,projector,kind,id,object,first_position,last_position,type), INSERT(workstream,projector,kind,id,object,first_position,last_position,type), UPDATE(object,first_position,last_position,type) ON objects TO agora_projector;
REVOKE ALL ON FUNCTION transcript_text(text, jsonb), transcript(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transcript_text(text, jsonb), transcript(uuid[]) TO agora_projector;
GRANT DELETE ON objects TO agora_projector;
GRANT SELECT(workstream,projector,version,position), INSERT(workstream,projector,version,position), UPDATE(version,position) ON checkpoints TO agora_projector;
GRANT DELETE ON checkpoints TO agora_projector;
GRANT SELECT(workstream,position,operation,kind,id,object), INSERT(workstream,position,operation,kind,id,object) ON thread TO agora_projector;
GRANT SELECT(owner,last_position), INSERT(owner), UPDATE(last_position) ON lists TO agora_projector;
GRANT SELECT(workstream,owner,position,changed_at,title,row), INSERT(workstream,owner,position,changed_at,title,row), UPDATE(position,changed_at,title,row) ON listings TO agora_projector;
GRANT SELECT(id,owner) ON workstreams TO agora_anchors;
GRANT SELECT(workstream,execution,session,kind,position) ON entries TO agora_anchors;
GRANT SELECT(id,workstream,execution,acp_id,opened_position,ended_position) ON sessions TO agora_anchors;
GRANT SELECT(id,workstream,execution,session,metadata,content,time), INSERT(id,workstream,execution,session,metadata,content) ON anchors TO agora_anchors;
