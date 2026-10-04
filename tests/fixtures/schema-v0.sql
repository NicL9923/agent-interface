-- Schema written by the unversioned store before PRAGMA user_version migrations (main 65df97a).
-- Migration tests open a copy of this database with the current store.
CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,picture TEXT);
CREATE TABLE sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE native_sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE native_flows(hash TEXT PRIMARY KEY,state TEXT NOT NULL,challenge TEXT NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE native_codes(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),state TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE native_devices(device_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL REFERENCES native_sessions(hash) ON DELETE CASCADE,token TEXT NOT NULL,environment TEXT NOT NULL,UNIQUE(token,environment));
CREATE TABLE routine_trials(request_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),routine_id TEXT NOT NULL,bot_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'uncertain');
CREATE TABLE today_seen(user_id TEXT PRIMARY KEY REFERENCES users(id),seen_at TEXT NOT NULL,event_frontier INTEGER NOT NULL DEFAULT 0);
CREATE TABLE card_state(user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,message_id TEXT NOT NULL,card_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(user_id,bot_id,message_id,card_id));
CREATE TABLE saved_items(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),pointer_key TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(user_id,pointer_key));
CREATE TABLE notification_batches(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL);
CREATE TABLE notification_batch_items(outbox_id TEXT PRIMARY KEY REFERENCES outbox(id),batch_id TEXT NOT NULL REFERENCES notification_batches(id));
CREATE TABLE preferences(user_id TEXT PRIMARY KEY REFERENCES users(id),value TEXT NOT NULL);
CREATE TABLE drafts(user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(user_id,bot_id));
CREATE TABLE read_positions(user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(user_id,bot_id));
CREATE TABLE bot_presentation(bot_id TEXT PRIMARY KEY,owner_id TEXT,shared INTEGER NOT NULL DEFAULT 1,avatar TEXT);
CREATE TABLE submissions(request_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,sender_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL,receipt TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE participants(run_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(run_id,user_id));
CREATE TABLE approval_attribution(approval_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),decision TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE routine_recipients(routine_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(routine_id,user_id));
CREATE TABLE subscriptions(endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),value TEXT NOT NULL);
CREATE TABLE outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,UNIQUE(event_id,user_id));
CREATE TABLE delivered(outbox_id TEXT NOT NULL REFERENCES outbox(id),endpoint TEXT NOT NULL,PRIMARY KEY(outbox_id,endpoint));
CREATE TABLE notification_events(id TEXT PRIMARY KEY,value TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE notification_ingestion(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE);
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
