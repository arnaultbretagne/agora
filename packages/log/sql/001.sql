-- Run as the migration owner. Runtime connections use separate non-owner logins.
DO $$ BEGIN CREATE ROLE agora_writer NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE agora_projector NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE agora_anchors NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS workstreams (
 id uuid PRIMARY KEY, owner uuid NOT NULL, last_position bigint NOT NULL DEFAULT 0 CHECK(last_position >= 0),
 last_thread_position bigint NOT NULL DEFAULT 0 CHECK(last_thread_position >= 0)
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
CREATE TABLE IF NOT EXISTS thread (
 workstream uuid NOT NULL REFERENCES workstreams(id), position bigint NOT NULL,
 operation text NOT NULL CHECK(operation IN ('upsert','remove','reset')), kind text, id uuid, object jsonb,
 PRIMARY KEY(workstream,position)
);
CREATE TABLE IF NOT EXISTS checkpoints (
 workstream uuid NOT NULL REFERENCES workstreams(id), projector text NOT NULL, version text NOT NULL,
 position bigint NOT NULL, PRIMARY KEY(workstream,projector)
);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON workstreams,entries,commands,sessions,diagnostics,anchors,objects,thread,checkpoints FROM agora_writer,agora_projector,agora_anchors;
REVOKE SELECT(content) ON anchors FROM agora_writer,agora_projector;
GRANT USAGE ON SCHEMA public TO agora_writer,agora_projector,agora_anchors;
GRANT SELECT(id,owner,last_position), INSERT(id,owner), UPDATE(last_position) ON workstreams TO agora_writer;
GRANT SELECT(workstream,position,kind,execution,session,content,time,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal),
 INSERT(workstream,position,kind,execution,session,content,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal) ON entries TO agora_writer;
GRANT SELECT(workstream,id,kind,target,fingerprint,answer,position,execution,claim_name), INSERT(workstream,id,kind,target,fingerprint,answer,position,execution,claim_name) ON commands TO agora_writer;
GRANT SELECT(id,workstream,execution,acp_id,opened_position,ended_position), INSERT(id,workstream,execution,acp_id,opened_position) ON sessions TO agora_writer;
GRANT SELECT(id,workstream,execution,connection,receive_ordinal,direction,reason,size,sha256,time), INSERT(id,workstream,execution,connection,receive_ordinal,direction,reason,size,sha256) ON diagnostics TO agora_writer;
GRANT UPDATE(ended_position) ON sessions TO agora_writer;
GRANT SELECT(id,workstream,execution,session,metadata,time) ON anchors TO agora_writer;
GRANT SELECT(id,owner,last_thread_position), UPDATE(last_thread_position) ON workstreams TO agora_projector;
GRANT SELECT(workstream,position,kind,execution,session,content,time,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal) ON entries TO agora_projector;
GRANT SELECT(workstream,projector,kind,id,object,first_position,last_position), INSERT(workstream,projector,kind,id,object,first_position,last_position), UPDATE(object,first_position,last_position) ON objects TO agora_projector;
GRANT DELETE ON objects TO agora_projector;
GRANT SELECT(workstream,projector,version,position), INSERT(workstream,projector,version,position), UPDATE(version,position) ON checkpoints TO agora_projector;
GRANT DELETE ON checkpoints TO agora_projector;
GRANT SELECT(workstream,position,operation,kind,id,object), INSERT(workstream,position,operation,kind,id,object) ON thread TO agora_projector;
GRANT SELECT(id,owner) ON workstreams TO agora_anchors;
GRANT SELECT(workstream,execution,session,kind,position) ON entries TO agora_anchors;
GRANT SELECT(id,workstream,execution,acp_id,opened_position,ended_position) ON sessions TO agora_anchors;
GRANT SELECT(id,workstream,execution,session,metadata,content,time), INSERT(id,workstream,execution,session,metadata,content) ON anchors TO agora_anchors;
